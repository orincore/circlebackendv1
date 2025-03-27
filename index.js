// index.js
const express = require("express");
const http = require("http");
const cors = require("cors");
const bodyParser = require("body-parser");
const { Server } = require("socket.io");
const supabase = require("./supabaseClient");
require("dotenv").config();
const { S3Client, PutObjectCommand, DeleteObjectCommand } =  require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");

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

const s3Client = new S3Client({
    region: process.env.AWS_REGION,
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    },
  });
  
  // Upload or Update Profile Picture
  app.post("/api/profile/upload", async (req, res) => {
    try {
      const { userId, fileName, fileType } = req.body;
  
      if (!userId || !fileName || !fileType) {
        return res.status(400).json({ error: "userId, fileName, and fileType are required" });
      }
  
      // Check required AWS environment variables
      const requiredVars = ['AWS_REGION', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_S3_BUCKET'];
      const missingVars = requiredVars.filter(v => !process.env[v]);
      if (missingVars.length > 0) {
        return res.status(500).json({ error: "Missing AWS configuration", missingVars });
      }
  
      const bucketName = process.env.AWS_S3_BUCKET;
      const userFolder = `profile-pictures/${userId}`;
      const objectKey = `${userFolder}/profile.jpg`;
  
      // Delete the old profile picture if it exists (overwriting)
      const deleteCommand = new DeleteObjectCommand({ Bucket: bucketName, Key: objectKey });
      try {
        await s3Client.send(deleteCommand);
      } catch (deleteError) {
        console.warn("No existing profile picture found or deletion error:", deleteError.message);
      }
  
      // Create new profile picture upload URL
      const putCommand = new PutObjectCommand({
        Bucket: bucketName,
        Key: objectKey,
        ContentType: fileType,
      });
  
      const presignedUrl = await getSignedUrl(s3Client, putCommand, { expiresIn: 3600 });
  
      res.json({
        uploadUrl: presignedUrl,
        publicUrl: `https://${bucketName}.s3.amazonaws.com/${objectKey}`,
      });
  
    } catch (error) {
      console.error("Profile picture upload error:", error);
      res.status(500).json({ error: error.message });
    }
  });
  
  // Delete Profile Picture
  app.delete("/api/profile/delete", async (req, res) => {
    try {
      const { userId } = req.body;
  
      if (!userId) {
        return res.status(400).json({ error: "userId is required" });
      }
  
      const bucketName = process.env.AWS_S3_BUCKET;
      const objectKey = `profile-pictures/${userId}/profile.jpg`;
  
      const deleteCommand = new DeleteObjectCommand({ Bucket: bucketName, Key: objectKey });
      await s3Client.send(deleteCommand);
  
      res.json({ message: "Profile picture deleted successfully" });
  
    } catch (error) {
      console.error("Profile picture deletion error:", error);
      res.status(500).json({ error: error.message });
    }
  });
// ------------------------------
// Socket/Chat Functionality
// ------------------------------

// In-memory data structures
const users = {}; // Map: socket.id => userId (obtained from Clerk on the client)
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
      // Insert private message into Supabase
      const { error } = await supabase.from("messages").insert([
        {
          room_id: null, // For one-to-one chat, you might leave room_id as null or generate one
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
      // Insert group message into Supabase
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
    // Broadcast the message to everyone in the room except the sender
    socket.to(roomId).emit("groupMessage", {
      senderId: users[socket.id],
      message,
    });
  });

  // Random Chat / Matching: User requests a random match
  socket.on("findRandomMatch", () => {
    const currentUserId = users[socket.id];
    console.log(`User ${currentUserId} is looking for a random match.`);
    if (!currentUserId) return;

    if (waitingQueue.length > 0) {
      // Found a waiting user; create a match
      const otherSocketId = waitingQueue.shift();
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

      // Retrieve user details from Supabase or use dummy data if not available.
      // For this example, we simulate with dummy data.
      const dummyMatchForSocket = {
        id: users[otherSocketId],
        name: "Adarsh Suradkar",
        age: 28,
        location: "Mumbai",
        gender: "Male",
      };
      const dummyMatchForOther = {
        id: currentUserId,
        name: "Your Match",
        age: 0,
        location: "",
        gender: "",
      };

      io.to(socket.id).emit("randomMatchStatus", {
        status: "pending",
        matchedUser: dummyMatchForSocket,
        roomId,
      });
      io.to(otherSocketId).emit("randomMatchStatus", {
        status: "pending",
        matchedUser: dummyMatchForOther,
        roomId,
      });
      console.log(
        `Matched ${currentUserId} with ${users[otherSocketId]} in room ${roomId}`
      );
    } else {
      waitingQueue.push(socket.id);
      console.log(`User ${currentUserId} added to waiting queue.`);
    }
  });

  // Random Chat: Handle acceptance from a user
  socket.on("randomMatchAccept", ({ roomId }) => {
    if (randomMatches[roomId]) {
      randomMatches[roomId].acceptances[socket.id] = true;
      const { acceptances, users: matchUsers } = randomMatches[roomId];
      if (matchUsers.every((id) => acceptances[id])) {
        // Both accepted: Emit connected status with matched user details
        // For real data, look up user details from Supabase or Clerk.
        matchUsers.forEach((sockId) => {
          io.to(sockId).emit("randomMatchStatus", {
            status: "connected",
            matchedUser: null, // In production, include complete matched user data
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

  // Random Chat: If a user rejects, notify and remove the match
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
        first_name: userData.first_name,
        last_name: userData.last_name,
        username: userData.username,
        email: userData.email_addresses?.[0]?.email_address,
        gender: userData.public_metadata?.gender || null,
        // You can add more fields as needed.
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
