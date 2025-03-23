// index.js
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

// Helper function to calculate age from a date string
const calculateAge = (dateString) => {
  if (!dateString) return null;
  const dobDate = new Date(dateString);
  const diffMs = Date.now() - dobDate.getTime();
  const ageDt = new Date(diffMs);
  return Math.abs(ageDt.getUTCFullYear() - 1970);
};

// ------------------------------
// Socket/Chat Functionality
// ------------------------------

// In-memory data structures
const users = {}; // Map: socket.id => userId (from Clerk)

// waitingQueue holds objects: { socketId, timestamp }
const WAITING_THRESHOLD = 15000; // 15 seconds threshold
const waitingQueue = [];

// randomMatches holds active random matches:
// { roomId: { users: [socketId1, socketId2],
//            acceptances: { [socketId]: boolean },
//            matchedUserData: { [socketId]: userProfileData } } }
const randomMatches = {};

io.on("connection", (socket) => {
  console.log("New client connected:", socket.id);

  // When a client joins, they send their user ID
  socket.on("join", (userId) => {
    users[socket.id] = userId;
    console.log(`User ${userId} connected with socket id ${socket.id}`);
  });

  // Private message event (one-to-one chat)
  socket.on("privateMessage", async ({ recipientId, message }) => {
    try {
      const { error } = await supabase.from("messages").insert([
        {
          room_id: null,
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
    // Emit message to the intended recipient
    Object.entries(users).forEach(([socketId, userId]) => {
      if (userId === recipientId) {
        io.to(socketId).emit("privateMessage", {
          senderId: users[socket.id],
          message,
        });
      }
    });
  });

  // Group Chat: Joining a room
  socket.on("joinRoom", (roomId) => {
    socket.join(roomId);
    console.log(`Socket ${socket.id} joined room ${roomId}`);
  });

  // Group Chat: Sending a group message
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

  // Random Chat / Matching: User requests a random match
  socket.on("findRandomMatch", async () => {
    const currentUserId = users[socket.id];
    console.log(`User ${currentUserId} is looking for a random match.`);
    if (!currentUserId) return;

    // Fetch current user's profile (interests) from Supabase
    const { data: currentProfile, error: currError } = await supabase
      .from("user_profiles")
      .select("interests")
      .eq("user_id", currentUserId)
      .single();

    if (currError || !currentProfile || !currentProfile.interests) {
      console.error("Current user's interests not found:", currError);
      socket.emit("randomMatchStatus", {
        status: "error",
        message: "Your profile is incomplete. Please update your interests.",
      });
      return;
    }

    const currentInterests = currentProfile.interests.split(", ").map((i) => i.toLowerCase());
    console.log(`User ${currentUserId} interests:`, currentInterests);

    // Check waitingQueue for an active waiting user within threshold
    const now = Date.now();
    const waitingEntryIndex = waitingQueue.findIndex(entry => now - entry.timestamp < WAITING_THRESHOLD);
    if (waitingEntryIndex === -1) {
      waitingQueue.push({ socketId: socket.id, timestamp: now });
      console.log(`User ${currentUserId} added to waiting queue.`);
      socket.emit("randomMatchStatus", {
        status: "waiting",
        message: "Waiting for another user to join...",
      });
      return;
    }

    // Found an active waiting user
    const waitingEntry = waitingQueue.splice(waitingEntryIndex, 1)[0];
    const otherSocketId = waitingEntry.socketId;
    const waitingUserId = users[otherSocketId];

    // Fetch profiles for both users
    const { data: currentUserProfile, error: error1 } = await supabase
      .from("user_profiles")
      .select("user_id, first_name, last_name, username, avatar, gender, location, date_of_birth, interests")
      .eq("user_id", currentUserId)
      .single();

    const { data: waitingUserProfile, error: error2 } = await supabase
      .from("user_profiles")
      .select("user_id, first_name, last_name, username, avatar, gender, location, date_of_birth, interests")
      .eq("user_id", waitingUserId)
      .single();

    if (error1 || error2 || !currentUserProfile || !waitingUserProfile) {
      console.error("Error fetching profiles for random match");
      socket.emit("randomMatchStatus", { status: "error", message: "Error finding matches." });
      return;
    }

    // Check mutual interests between current user and waiting user
    const interests1 = currentUserProfile.interests.split(", ").map((i) => i.toLowerCase());
    const interests2 = waitingUserProfile.interests.split(", ").map((i) => i.toLowerCase());
    const hasMutual = interests1.some(i => interests2.includes(i));
    if (!hasMutual) {
      console.log(`No mutual interests between ${currentUserId} and ${waitingUserId}`);
      socket.emit("randomMatchStatus", { status: "error", message: "No mutual interests found." });
      return;
    }

    // Create match room and store match data
    const roomId = `random-${socket.id}-${otherSocketId}`;
    randomMatches[roomId] = {
      users: [socket.id, otherSocketId],
      acceptances: { [socket.id]: false, [otherSocketId]: false },
      matchedUserData: {
        [socket.id]: {
          id: waitingUserProfile.user_id,
          name: `${waitingUserProfile.first_name} ${waitingUserProfile.last_name}`.trim() || waitingUserProfile.username,
          age: calculateAge(waitingUserProfile.date_of_birth),
          location: waitingUserProfile.location,
          gender: waitingUserProfile.gender,
          avatar: waitingUserProfile.avatar || "https://via.placeholder.com/40",
        },
        [otherSocketId]: {
          id: currentUserProfile.user_id,
          name: `${currentUserProfile.first_name} ${currentUserProfile.last_name}`.trim() || currentUserProfile.username,
          age: calculateAge(currentUserProfile.date_of_birth),
          location: currentUserProfile.location,
          gender: currentUserProfile.gender,
          avatar: currentUserProfile.avatar || "https://via.placeholder.com/40",
        }
      }
    };

    // Join both sockets to the room
    socket.join(roomId);
    const otherSocket = io.sockets.sockets.get(otherSocketId);
    if (otherSocket) {
      otherSocket.join(roomId);
    }

    // Emit pending match status to both users with matched data
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
  });

  // Random Chat: Handle acceptance from a user
  socket.on("randomMatchAccept", ({ roomId }) => {
    if (randomMatches[roomId]) {
      randomMatches[roomId].acceptances[socket.id] = true;
      console.log(`Socket ${socket.id} accepted match in room ${roomId}`);
      const { acceptances, users: matchUsers, matchedUserData } = randomMatches[roomId];
      // Check if both users have accepted
      if (matchUsers.every(id => acceptances[id])) {
        // Both accepted: Emit connected status with full matched data to both
        matchUsers.forEach(sockId => {
          io.to(sockId).emit("randomMatchStatus", {
            status: "connected",
            matchedUser: matchedUserData[sockId],
            roomId,
          });
        });
        console.log(`Both users accepted match in room ${roomId}`);
      } else {
        // Only one has accepted; emit waiting status to the socket that just accepted
        io.to(socket.id).emit("randomMatchStatus", {
          status: "waiting",
          matchedUser: matchedUserData[socket.id],
          roomId,
        });
      }
    }
  });

  // Random Chat: Handle rejection from a user
  socket.on("randomMatchReject", ({ roomId }) => {
    if (randomMatches[roomId]) {
      io.to(roomId).emit("randomMatchStatus", { status: "rejected", roomId });
      console.log(`Match in room ${roomId} was rejected.`);
      delete randomMatches[roomId];
      waitingQueue.push({ socketId: socket.id, timestamp: Date.now() });
    }
  });

  // Random Chat: User cancels random match request
  socket.on("cancelRandomMatch", () => {
    const index = waitingQueue.findIndex(entry => entry.socketId === socket.id);
    if (index !== -1) {
      waitingQueue.splice(index, 1);
      console.log(`User ${users[socket.id]} removed from waiting queue.`);
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
// Clerk Webhook for Syncing with Supabase
// ------------------------------

app.post("/api/clerk-webhook", async (req, res) => {
  const event = req.body;

  // NOTE: Validate webhook signature here for security (omitted for brevity)

  try {
    if (event.type === "user.created" || event.type === "user.updated") {
      const userData = event.data;
      const profileData = {
        user_id: userData.id,
        first_name: userData.first_name,
        last_name: userData.last_name,
        username: userData.username,
        email: userData.email_addresses?.[0]?.email_address,
        gender: userData.public_metadata?.gender || null,
        // Include additional fields as needed.
      };

      const { error } = await supabase
        .from("user_profiles")
        .upsert(profileData, { onConflict: "user_id" });
      if (error) {
        console.error("Supabase upsert error:", error.message);
        return res.status(500).json({ error: error.message });
      }
      console.log("Synced user data to Supabase:", userData.id);
    } else if (event.type === "user.deleted") {
      const userId = event.data.id;
      const { error } = await supabase
        .from("user_profiles")
        .delete()
        .eq("user_id", userId);
      if (error) {
        console.error("Supabase deletion error:", error.message);
        return res.status(500).json({ error: error.message });
      }
      console.log("Deleted user from Supabase:", userId);
    }
    res.status(200).json({ received: true });
  } catch (err) {
    console.error("Webhook error:", err);
    res.status(500).json({ error: "Internal server error" });
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
