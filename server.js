// server.js
import express from "express";
import dotenv from "dotenv";
import cookieParser from "cookie-parser";
import mongoose from "mongoose";
import path from "path";
import cors from "cors";
import http from "http"; // Required to create the HTTP server
import { io } from "./config/socket.js"; // Import the ioSetup function
import {startScheduledNotificationWorker} from "./scheduler/notificationSchedule.js";



// Import your routes
import authRoutes from "./routes/auth.js";
import userRoutes from "./routes/user.js";;
import notificationRoutes from "./routes/notification.js";


dotenv.config();

const app = express();

// If behind a proxy (Render, Vercel, Heroku) ensure Express knows about it
app.set("trust proxy", 1);

// Recommended: read allowed origins from env or fallback to the list you used
const allowedOrigins = (process.env.ALLOWED_ORIGINS || "http://localhost:3000,https://service-xpress-frontend.vercel.app,https://fdd6a7d398fb.ngrok-free.app,https://service-xpress-frontend-kyrc.vercel.app,https://servicexpress-frontend.onrender.com")
  .split(",")
  .map((s) => s.trim());

// CORS options: echo back the origin only when allowed, and allow credentials
const corsOptions = {
  origin: (origin, callback) => {
    // allow server-to-server, mobile clients and tools without Origin
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) return callback(null, true);
    return callback(new Error("Not allowed by CORS"));
  },
  credentials: true,
  methods: ["GET", "HEAD", "PUT", "PATCH", "POST", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "X-Requested-With"],
};

// Apply CORS and preflight handling
app.use(cors(corsOptions));
app.options("*", cors(corsOptions));

// Middlewares
app.use(cookieParser());
// Increase JSON body limit slightly (tweak if necessary). Keeps you from throwing for moderate payloads.
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ limit: "10mb", extended: true }));

// Define your API routes
app.use("/api/auth", authRoutes);
app.use("/api/users", userRoutes);
app.use("/api/notification", notificationRoutes);

app.use("/images", express.static(path.join(process.cwd(), "public/images")));

// Error handler middleware
app.use((err, req, res, next) => {
  console.error("ERROR-MIDDLEWARE:", err && err.message ? err.message : err);
  const status = err.status || 500;
  const message = err.message || "Something went wrong!";
  return res.status(status).json({
    success: false,
    status,
    message,
  });
});

// Database connection and server setup
mongoose
  .connect(process.env.DB_CONNECTION)
  .then(() => {
    console.log("Connected to database");

    // Create HTTP server and pass it to the ioSetup function
    const server = http.createServer(app);

    // Initialize Socket.IO
    io(server, allowedOrigins);

// Start scheduled notifications worker (use the correct scheduler filename)

const stopScheduler = startScheduledNotificationWorker(30 * 1000);(30 * 1000);
    // Start listening for requests
    server.listen(process.env.PORT || 8080, () => {
      console.log(`Server is running on port${im not telling you}`);
    });
   const shutdown = async () => {
      console.log("Shutting down...");
      if (typeof stopScheduler === "function") stopScheduler();
      server.close(() => {
        console.log("HTTP server closed");
        mongoose.disconnect().then(() => {
          console.log("Mongo disconnected");
          process.exit(0);
        });
      });
      // force exit after timeout
      setTimeout(() => process.exit(1), 10000);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);

  })
  .catch((err) => console.log(`Error connecting to database: ${err}`));
