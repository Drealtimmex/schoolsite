// config/socket.js
import { Server } from "socket.io";
import jwt from "jsonwebtoken";
import cookie from "cookie";
import User from "../model/User.js";

/**
 * Map<userId, { role?: string, sockets: Set<socketId> }>
 */
export const connectedUsers = new Map();

/**
 * Initialize socket.io
 * - server: HTTP server
 * - allowedOrigins: array of allowed origins (strings) or a single string
 */
export const io = (server, allowedOrigins = ["*"]) => {
  const io = new Server(server, {
    cors: {
      origin: allowedOrigins,
      methods: ["GET", "POST", "PATCH", "DELETE", "PUT"],
      credentials: true
    },
    // adjust pingInterval / pingTimeout if needed
  });

  // attach the instance to global for other modules that import emit helpers
  global.io = io;

  /**
   * Socket handshake authentication
   */
  io.use(async (socket, next) => {
    try {
      let token = socket.handshake?.auth?.token;

      if (!token && socket.handshake?.headers?.cookie) {
        const cookies = cookie.parse(socket.handshake.headers.cookie || "");
        if (cookies.access_token) token = cookies.access_token;
      }

      if (!token && socket.handshake?.headers?.authorization) {
        const h = socket.handshake.headers.authorization;
        if (typeof h === "string" && h.startsWith("Bearer ")) token = h.split(" ")[1].trim();
      }

      if (!token) {
        return next(new Error("Authentication error: token missing"));
      }

      let payload;
      try {
        payload = jwt.verify(token, process.env.JWT);
      } catch (err) {
        return next(new Error("Authentication error: invalid or expired token"));
      }

      if (!payload || !payload.id) {
        return next(new Error("Authentication error: invalid token payload"));
      }

      // Load user to get fresh role / validate existence
      const user = await User.findById(payload.id).select("_id role").lean();
      if (!user) return next(new Error("Authentication error: user not found"));

      // Attach authenticated user info to socket
      socket.data.userId = String(user._id);
      socket.data.role = payload.role || user.role || "user";

      return next();
    } catch (err) {
      console.error("Socket auth error:", err);
      return next(new Error("Authentication error"));
    }
  });

  io.on("connection", (socket) => {
    const sid = socket.id;
    const uid = socket.data.userId;
    const role = socket.data.role;

    console.log(`[SOCKET] connected ${sid} uid=${uid} role=${role}`);

    // Register the socket id under the user's entry
    if (uid) {
      let entry = connectedUsers.get(uid);
      if (!entry) {
        entry = { role, sockets: new Set() };
        connectedUsers.set(uid, entry);
      } else {
        // keep stored role up-to-date (role at connection time)
        entry.role = role;
      }
      entry.sockets.add(sid);

      // JOIN user & role rooms — important for reliable emits and clustering adapters
      try {
        socket.join(`user:${uid}`);
        socket.join(`role:${role}`);
      } catch (err) {
        console.warn(`[SOCKET] join room failed for ${sid}`, err);
      }
    }

    // Send snapshot of online user ids (if you want)
    socket.emit("onlineUsers", Array.from(connectedUsers.keys()));

    // Tell others that this user is online
    socket.broadcast.emit("userOnline", { userId: uid, role, status: "online" });

    // Optional events: presence:watch etc.
    socket.on("presence:watch", ({ userId }) => {
      console.log(`[SOCKET] ${sid} watching presence for ${userId}`);
    });

    // Clean up on disconnect
    socket.on("disconnect", () => {
      const entry = connectedUsers.get(uid);
      if (!entry) return;
      entry.sockets.delete(sid);
      if (entry.sockets.size === 0) {
        connectedUsers.delete(uid);
        socket.broadcast.emit("userOffline", { userId: uid, role: entry.role, status: "offline" });
        console.log(`[SOCKET] user ${uid} OFFLINE`);
      } else {
        console.log(`[SOCKET] user ${uid} still has ${entry.sockets.size} socket(s)`);
      }
      // socket automatically leaves rooms on disconnect
    });
  });

  return io;
};

/** Emit to all sockets of a specific user. Returns number of sockets emitted to. */
export const emitToUser = (userId, event, payload) => {
  const entry = connectedUsers.get(String(userId));
  if (!entry) return 0;

  // Prefer room-based emit (works with adapters and is efficient)
  if (global.io) {
    try {
      global.io.to(`user:${userId}`).emit(event, payload);
      // return how many sockets we know this user has
      return entry.sockets.size;
    } catch (err) {
      console.warn("emitToUser room emit failed, falling back to per-socket emit", err);
    }
  } else {
    console.warn("emitToUser: global.io is not defined");
    return 0;
  }

  // fallback (shouldn't run if room emit succeeded)
  let count = 0;
  for (const sid of entry.sockets) {
    try {
      global.io.to(sid).emit(event, payload);
      count++;
    } catch (err) {
      console.warn("emitToUser error", err);
    }
  }
  return count;
};

/** Emit to all sockets of all users with a role. Returns number of sockets emitted to. */
export const emitToRole = (role, event, payload) => {
  // prefer room-based emit
  if (global.io) {
    try {
      global.io.to(`role:${role}`).emit(event, payload);
      // count sockets for bookkeeping
      let count = 0;
      for (const [, entry] of connectedUsers.entries()) {
        if (entry.role === role) count += entry.sockets.size;
      }
      return count;
    } catch (err) {
      console.warn("emitToRole room emit failed, falling back to per-socket emit", err);
    }
  } else {
    console.warn("emitToRole: global.io is not defined");
    return 0;
  }

  // fallback (rare)
  let count = 0;
  for (const [uid, entry] of connectedUsers.entries()) {
    if (entry.role === role) {
      for (const sid of entry.sockets) {
        try {
          global.io.to(sid).emit(event, payload);
          count++;
        } catch (err) {
          console.warn("emitToRole error", err);
        }
      }
    }
  }
  return count;
};
