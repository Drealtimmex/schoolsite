// routes/notifications.js
import express from "express";
import {
  createNotification,
  getMyNotifications,
  markAsRead,
  getNotificationById,
  listNotificationsAdmin
} from "../controller/notification.js";
import { verifyToken } from "../verifyToken.js";

const router = express.Router();

router.post("/", verifyToken, createNotification); // create immediate or scheduled
router.get("/me", verifyToken, getMyNotifications);
router.patch("/:notificationId/read", verifyToken, markAsRead);
router.get("/:id", verifyToken, getNotificationById);

// Admin/staff listing with filters
router.get("/", verifyToken, listNotificationsAdmin);

export default router;
