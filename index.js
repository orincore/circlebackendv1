const express = require("express");
const http = require("http");
const cors = require("cors");
const bodyParser = require("body-parser");
const { Server } = require("socket.io");
const supabase = require("./supabaseClient");
require("dotenv").config();

const app = express();
app.use(cors());
app.use(express.json());
app.use(bodyParser.json());

const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: "*", // In production, set this to your frontend's URL
    methods: ["GET", "POST"],
  },
});

// ------------------------------
// Helper Functions
// ------------------------------

// Calculate age from date string
const calculateAge = (dateString) => {
  if (!dateString) return null;
  const dobDate = new Date(dateString);
  const diffMs = Date.now() - dobDate.getTime();
  const ageDt = new Date(diffMs);
  return Math.abs(ageDt.getUTCFullYear() - 1970);
};

// Normalize interests
const normalizeInterests = (interests) => {
  if (!interests) return [];
  return interests
    .split(/,\s*|;/) // Handle both comma and semicolon separated
    .map(i => i.toLowerCase().trim())
    .filter(i => i.length > 0);
};

// ------------------------------
// In-Memory Data Structures
// ------------------------------

const users = {}; // Map: socket.id => userId
const waitingQueue = []; // { socketId, timestamp }
const randomMatches = {}; // Active random matches
const WAITING_THRESHOLD = 15000; // 15 seconds

// ------------------------------
// Socket.IO Event Handlers
// ------------------------------

io.on("connection", (socket) => {
  console.log("New client connected:", socket.id);

  // When a client joins, store their user ID
  socket.on("join", (userId) => {
    users[socket.id] = userId;
    console.log(`User ${userId} connected with socket id ${socket.id}`);
  });

  // Private message handler
  socket.on("privateMessage", async ({ recipientId, message }) => {
    try {
      const { error } = await supabase.from("messages").insert([
        {
          sender_id: users[socket.id],
          recipient_id: recipientId,
          content: message,
          timestamp: new Date().toISOString(),
        },
      ]);
      if (error) console.error("Supabase insertion error:", error);
    } catch (err) {
      console.error("Error inserting private message:", err);
    }
    // Emit to recipient
    Object.entries(users).forEach(([socketId, userId]) => {
      if (userId === recipientId) {
        io.to(socketId).emit("privateMessage", {
          senderId: users[socket.id],
          message,
        });
      }
    });
  });

  // Group chat handler
  socket.on("groupMessage", async ({ roomId, message }) => {
    try {
      const { error } = await supabase.from("messages").insert([
        {
          room_id: roomId,
          sender_id: users[socket.id],
          content: message,
          timestamp: new Date().toISOString(),
        },
      ]);
      if (error) console.error("Supabase insertion error:", error);
    } catch (err) {
      console.error("Error inserting group message:", err);
    }
    socket.to(roomId).emit("groupMessage", {
      senderId: users[socket.id],
      message,
    });
  });

  // Random Matchmaking Handler
  socket.on("findRandomMatch", async () => {
    const currentUserId = users[socket.id];
    if (!currentUserId) return;

    try {
      // 1. Fetch current user's profile
      const { data: currentProfile, error: profileError } = await supabase
        .from("user_profiles")
        .select("user_id, username, interests, gender, location, date_of_birth, avatar_url")
        .eq("user_id", currentUserId)
        .single();

      if (profileError || !currentProfile?.interests) {
        console.error("Profile fetch error:", profileError);
        return socket.emit("randomMatchStatus", {
          status: "error",
          message: "Your profile is incomplete. Please update your interests.",
        });
      }

      // 2. Normalize interests
      const currentInterests = normalizeInterests(currentProfile.interests);
      console.log(`User ${currentUserId} interests:`, currentInterests);

      // 3. Check waiting queue for matches
      const now = Date.now();
      const waitingEntryIndex = waitingQueue.findIndex(
        entry => now - entry.timestamp < WAITING_THRESHOLD
      );

      if (waitingEntryIndex === -1) {
        waitingQueue.push({ socketId: socket.id, timestamp: now });
        console.log(`User ${currentUserId} added to waiting queue.`);
        return socket.emit("randomMatchStatus", {
          status: "waiting",
          message: "Waiting for another user to join...",
        });
      }

      // 4. Found a waiting user
      const waitingEntry = waitingQueue.splice(waitingEntryIndex, 1)[0];
      const otherSocketId = waitingEntry.socketId;
      const waitingUserId = users[otherSocketId];

      // 5. Fetch waiting user's profile
      const { data: waitingProfile, error: waitingError } = await supabase
        .from("user_profiles")
        .select("user_id, username, interests, gender, location, date_of_birth, avatar_url")
        .eq("user_id", waitingUserId)
        .single();

      if (waitingError || !waitingProfile) {
        console.error("Waiting user profile error:", waitingError);
        return socket.emit("randomMatchStatus", {
          status: "error",
          message: "Error finding matches.",
        });
      }

      // 6. Check mutual interests
      const waitingInterests = normalizeInterests(waitingProfile.interests);
      const hasMutual = currentInterests.some(i => waitingInterests.includes(i));

      if (!hasMutual) {
        console.log(`No mutual interests between ${currentUserId} and ${waitingUserId}`);
        return socket.emit("randomMatchStatus", {
          status: "error",
          message: "No compatible interests found.",
        });
      }

      // 7. Create match room
      const roomId = "random-" + [socket.id, otherSocketId].sort().join("-");
      randomMatches[roomId] = {
        users: [socket.id, otherSocketId],
        acceptances: { [socket.id]: false, [otherSocketId]: false },
        matchedUserData: {
          [socket.id]: {
            id: waitingUserId,
            name: waitingProfile.username || `User ${waitingUserId.slice(-4)}`,
            age: calculateAge(waitingProfile.date_of_birth),
            location: waitingProfile.location,
            gender: waitingProfile.gender,
            avatar: waitingProfile.avatar_url || "https://via.placeholder.com/40",
          },
          [otherSocketId]: {
            id: currentUserId,
            name: currentProfile.username || `User ${currentUserId.slice(-4)}`,
            age: calculateAge(currentProfile.date_of_birth),
            location: currentProfile.location,
            gender: currentProfile.gender,
            avatar: currentProfile.avatar_url || "https://via.placeholder.com/40",
          },
        },
      };

      // 8. Join both users to the room
      socket.join(roomId);
      const otherSocket = io.sockets.sockets.get(otherSocketId);
      if (otherSocket) otherSocket.join(roomId);

      // 9. Notify both users
      io.to(socket.id).emit("randomMatchStatus", {
        status: "pending",
        matchedUser: randomMatches[roomId].matchedUserData[socket.id],
        roomId,
      });

      io.to(otherSocketId).emit("randomMatchStatus", {
        status: "pending",
        matchedUser: randomMatches[roomId].matchedUserData[otherSocketId],
        roomId,
      });

      console.log(`Matched ${currentUserId} with ${waitingUserId} in room ${roomId}`);

    } catch (err) {
      console.error("Matchmaking error:", err);
      socket.emit("randomMatchStatus", {
        status: "error",
        message: "Failed to process match request.",
      });
    }
  });

  // Handle match acceptance
  socket.on("randomMatchAccept", ({ roomId }) => {
    if (randomMatches[roomId]) {
      randomMatches[roomId].acceptances[socket.id] = true;
      const { acceptances, users: matchUsers, matchedUserData } = randomMatches[roomId];

      if (matchUsers.every(id => acceptances[id])) {
        // Both accepted
        matchUsers.forEach(sockId => {
          io.to(sockId).emit("randomMatchStatus", {
            status: "connected",
            matchedUser: matchedUserData[sockId],
            roomId,
          });
        });
        console.log(`Both users accepted match in room ${roomId}`);
      } else {
        // Only one accepted
        io.to(socket.id).emit("randomMatchStatus", {
          status: "waiting",
          matchedUser: matchedUserData[socket.id],
          roomId,
        });
      }
    }
  });

  // Handle match rejection
  socket.on("randomMatchReject", ({ roomId }) => {
    if (randomMatches[roomId]) {
      io.to(roomId).emit("randomMatchStatus", { status: "rejected", roomId });
      delete randomMatches[roomId];
      waitingQueue.push({ socketId: socket.id, timestamp: Date.now() });
    }
  });

  // Handle disconnect
  socket.on("disconnect", () => {
    console.log("Client disconnected:", socket.id);
    delete users[socket.id];
    const index = waitingQueue.findIndex(entry => entry.socketId === socket.id);
    if (index !== -1) waitingQueue.splice(index, 1);
  });
});

// ------------------------------
// Clerk Webhook Handler
// ------------------------------

app.post("/api/clerk-webhook", async (req, res) => {
  const event = req.body;
  try {
    if (event.type === "user.created" || event.type === "user.updated") {
      const userData = event.data;
      const primaryEmail = userData.email_addresses?.find(
        email => email.id === userData.primary_email_address_id
      )?.email_address || null;

      const profileData = {
        user_id: userData.id,
        first_name: userData.first_name || null,
        last_name: userData.last_name || null,
        email: primaryEmail,
        username: userData.username || null,
        avatar_url: userData.profile_image_url || "https://via.placeholder.com/40",
        updated_at: new Date().toISOString(),
      };

      const { error } = await supabase
        .from("user_profiles")
        .upsert(profileData, { onConflict: "user_id" });

      if (error) {
        console.error("Supabase error:", error);
        return res.status(500).json({ error: error.message });
      }
      console.log(`Synced user ${userData.id}`);
      return res.status(200).json({ success: true });
    }
  } catch (err) {
    console.error("Webhook error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// ------------------------------
// Basic Route and Server Start
// ------------------------------

app.get("/", (req, res) => {
  res.send("Chat backend is running.");
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
