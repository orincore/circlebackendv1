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
    origin: "*", // Adjust for production: set allowed origins
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
const waitingQueue = []; // Array of socket IDs waiting for a random match

// Object to hold active random matches
// Format: { roomId: { users: [socketId1, socketId2], acceptances: { socketId1: boolean, socketId2: boolean } } }
const randomMatches = {};

io.on("connection", (socket) => {
  console.log("New client connected:", socket.id);

  // When a client joins, they should send their user id
  socket.on("join", (userId) => {
    users[socket.id] = userId;
    console.log(`User ${userId} connected with socket id ${socket.id}`);
  });

  // Private message event (one-to-one chat)
  socket.on("privateMessage", async ({ recipientId, message }) => {
    try {
      const { error } = await supabase.from("messages").insert([
        {
          room_id: null, // For one-to-one chat
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
    // Emit the message to the intended recipient
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

    // Fetch current user's profile from Supabase
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

    // Get current user's interests as an array (all lower-case)
    const currentInterests = currentProfile.interests.split(", ").map((i) => i.toLowerCase());

    // Query Supabase for potential matches (excluding the current user)
    const { data: potentialMatches, error: matchError } = await supabase
      .from("user_profiles")
      .select("user_id, first_name, last_name, username, avatar, interests, gender, location, date_of_birth")
      .neq("user_id", currentUserId);

    if (matchError) {
      console.error("Error fetching potential matches:", matchError);
      socket.emit("randomMatchStatus", { status: "error", message: "Error finding matches." });
      return;
    }

    // Filter potential matches for at least one mutual interest
    const mutualMatches = potentialMatches.filter((match) => {
      if (!match.interests) return false;
      const matchInterests = match.interests.split(", ").map((i) => i.toLowerCase());
      return currentInterests.some((ci) => matchInterests.includes(ci));
    });

    if (mutualMatches.length === 0) {
      socket.emit("randomMatchStatus", { status: "error", message: "No compatible matches found." });
      return;
    }

    // Pick a random match from mutualMatches
    const randomMatch = mutualMatches[Math.floor(Math.random() * mutualMatches.length)];

    // Ensure the matched user is online (exists in our in-memory users object)
    const otherSocketId = Object.keys(users).find((sid) => users[sid] === randomMatch.user_id);
    if (!otherSocketId) {
      socket.emit("randomMatchStatus", { status: "error", message: "No compatible online matches found." });
      return;
    }

    const roomId = `random-${socket.id}-${otherSocketId}`;
    randomMatches[roomId] = {
      users: [socket.id, otherSocketId],
      acceptances: { [socket.id]: false, [otherSocketId]: false },
    };

    socket.join(roomId);
    const otherSocket = io.sockets.sockets.get(otherSocketId);
    if (otherSocket) {
      otherSocket.join(roomId);
    }

    // Prepare the matched user data to send to the current socket
    const matchedUserData = {
      id: randomMatch.user_id,
      name: `${randomMatch.first_name || randomMatch.username} ${randomMatch.last_name || ""}`.trim(),
      age: calculateAge(randomMatch.date_of_birth),
      location: randomMatch.location,
      gender: randomMatch.gender,
      avatar: randomMatch.avatar || "https://via.placeholder.com/40",
    };

    // Emit pending match status to both users with respective matched user data
    io.to(socket.id).emit("randomMatchStatus", {
      status: "pending",
      matchedUser: matchedUserData,
      roomId,
    });
    // For the other socket, you may choose to send minimal details or mask them
    io.to(otherSocketId).emit("randomMatchStatus", {
      status: "pending",
      matchedUser: { id: currentUserId, name: "Your Match" },
      roomId,
    });
    console.log(`Matched ${currentUserId} with ${randomMatch.user_id} in room ${roomId}`);
  });

  // Random Chat: Handle acceptance from a user
  socket.on("randomMatchAccept", ({ roomId }) => {
    if (randomMatches[roomId]) {
      randomMatches[roomId].acceptances[socket.id] = true;
      const { acceptances, users: matchUsers } = randomMatches[roomId];
      if (matchUsers.every((id) => acceptances[id])) {
        // Both accepted: Emit connected status with complete matched user data
        // Look up the matched user details from one of the pending events (for demonstration, assume current socket's match data)
        matchUsers.forEach((sockId) => {
          io.to(sockId).emit("randomMatchStatus", {
            status: "connected",
            matchedUser: null, // You can include matched user details if needed
            roomId,
          });
        });
      } else {
        io.to(socket.id).emit("randomMatchStatus", {
          status: "pending",
          matchedUser: null,
          roomId,
        });
      }
    }
  });

  // Random Chat: Handle rejection from a user
  socket.on("randomMatchReject", ({ roomId }) => {
    if (randomMatches[roomId]) {
      io.to(roomId).emit("randomMatchStatus", { status: "rejected", roomId });
      delete randomMatches[roomId];
      waitingQueue.push(socket.id);
    }
  });

  // Random Chat: User cancels random match request (from sidebar)
  socket.on("cancelRandomMatch", () => {
    const index = waitingQueue.indexOf(socket.id);
    if (index !== -1) {
      waitingQueue.splice(index, 1);
      console.log(`User ${users[socket.id]} removed from waiting queue.`);
    }
  });

  // Handle disconnect
  socket.on("disconnect", () => {
    console.log("Client disconnected:", socket.id);
    delete users[socket.id];
    const index = waitingQueue.indexOf(socket.id);
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
        first_name: userData.first_name,  // Ensure this field is provided by Clerk
        last_name: userData.last_name,    // Ensure this field is provided by Clerk
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
