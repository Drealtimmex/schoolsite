// controllers/notifications.js
import Notification from "../models/Notification.js";
import User from "../models/User.js";
import { emitToUser, emitToRole } from "../config/socket.js";
import mongoose from "mongoose";
import { createError } from "../error.js";

/**
 * Helper: build a Mongo query to resolve recipients based on target + sender rules
 * department is a plain string on User, and target.departments is an array of strings.
 */
const buildRecipientQuery = async ({ sender, senderRole, target = {} }) => {
  const q = { isActive: true };

  // Roles logic
  if (Array.isArray(target.roles) && target.roles.length > 0) {
    q.role = { $in: target.roles };
  } else {
    if (target.studentsOnly && !target.staffOnly) {
      q.role = "student";
    } else if (target.staffOnly && !target.studentsOnly) {
      q.role = { $in: ["lecturer", "hod", "levelAdviser", "dean", "subDean", "facultyOfficer", "admin"] };
    } // else no explicit role filter (include everyone matching dept/level)
  }

  // If target.all === true => don't filter by dept/level (respect studentsOnly/staffOnly)
  if (target.all) {
    return q;
  }

  // Department filtering: target.departments is expected as array of strings
  if (Array.isArray(target.departments) && target.departments.length > 0) {
    // match users whose department (string) is in the provided list
    q.department = { $in: target.departments.map(d => String(d).trim()) };
  } else {
    // default to sender.department for department-scoped roles
    const deptScoped = ["lecturer", "hod", "levelAdviser"];
    if (deptScoped.includes(senderRole) && sender?.department) {
      q.department = sender.department;
    }
    // else: no department filter (means all departments)
  }

  // Level filtering
  if (Array.isArray(target.levels) && target.levels.length > 0) {
    q.level = { $in: target.levels.map(Number) };
  }

  return q;
};

/**
 * Send a prepared Notification doc immediately (resolve recipients if needed)
 */
export const sendNotificationNow = async (notification) => {
  let recipients = [];

  // If items present, resolve users from those ids
  if (Array.isArray(notification.items) && notification.items.length > 0) {
    const userIds = notification.items.map(it => it.user).filter(Boolean);
    recipients = await User.find({ _id: { $in: userIds } }).select("_id name email deviceTokens role department level").lean();
  } else {
    // resolve via target + sender
    const sender = await User.findById(notification.sender).select("_id department role name email level").lean();
    if (!sender) {
      // mark failed
      notification.status = "failed";
      notification.meta = { lastError: "sender_not_found" };
      await notification.save();
      return { recipientsCount: 0, emittedSockets: 0 };
    }

    const recipientQuery = await buildRecipientQuery({ sender, senderRole: notification.senderRole, target: notification.target || {} });

    // enforce studentsOnly/staffOnly
    if (notification.target?.studentsOnly) recipientQuery.role = "student";
    else if (notification.target?.staffOnly) recipientQuery.role = { $in: ["lecturer","hod","levelAdviser","dean","subDean","facultyOfficer","admin"] };

    recipients = await User.find(recipientQuery).select("_id name email deviceTokens role department level").lean();

    // persist items for delivery/read-tracking
    notification.items = recipients.map(r => ({ user: r._id }));
    await notification.save();
  }

  // dedupe recipients
  const seen = new Set();
  recipients = recipients.filter(r => {
    const id = String(r._id);
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });

  // emit to each online user
  let emittedSockets = 0;
  for (const r of recipients) {
    try {
      const payload = {
        notificationId: notification._id,
        title: notification.title,
        content: notification.content,
        from: { id: notification.sender, role: notification.senderRole },
        createdAt: notification.createdAt
      };
      emittedSockets += emitToUser(String(r._id), "notification:new", payload);
    } catch (err) {
      console.error("emit error", err);
    }
  }

  // optional: emit to role channels if requested
  if (Array.isArray(notification.target?.roles) && notification.target.roles.length > 0) {
    for (const role of notification.target.roles) {
      emittedSockets += emitToRole(role, "notification:new", {
        notificationId: notification._id,
        title: notification.title,
        content: notification.content,
        from: { id: notification.sender, role: notification.senderRole }
      });
    }
  }

  notification.status = "completed";
  notification.deliveryCount = recipients.length;
  await notification.save();

  return { recipientsCount: recipients.length, emittedSockets };
};

/**
 * Create notification endpoint (immediate or scheduled)
 */
export const createNotification = async (req, res, next) => {
  try {
    const senderId = req.user?.id;
    const senderRole = req.user?.role;
    if (!senderId) return next(createError(401, "Unauthorized"));

    const { title, content, html, channels = ["inapp"], target = {}, priority = "normal", meta = {}, scheduledAt } = req.body;
    if (!content) return next(createError(400, "Content required"));

    // load sender (department is string)
    const sender = await User.findById(senderId).select("_id department role name email level").lean();
    if (!sender) return next(createError(400, "Sender not found"));

    // LevelAdviser default level behavior
    if (senderRole === "levelAdviser" && !target.levels && sender.level) {
      target.levels = [sender.level];
    }

    // default target behaviour
    const staffRolesNoDeptAllowed = ["dean", "subDean", "admin"];
    if (!target || Object.keys(target).length === 0) {
      if (staffRolesNoDeptAllowed.includes(senderRole)) {
        target.all = true;
        target.studentsOnly = true;
      } else {
        target.studentsOnly = true;
      }
    }

    // create notification doc (target.departments expected as array of strings if passed)
    const notification = new Notification({
      sender: sender._id,
      senderRole,
      title,
      content,
      html,
      channels,
      target,
      priority,
      meta,
      status: scheduledAt ? "scheduled" : "queued",
      scheduledAt: scheduledAt ? new Date(scheduledAt) : undefined
    });

    await notification.save();

    // scheduled -> don't send now
    if (scheduledAt) {
      return res.status(201).json({ message: "Notification scheduled", notificationId: notification._id, scheduledAt: notification.scheduledAt });
    }

    // send now
    const stats = await sendNotificationNow(notification);
    return res.status(201).json({ message: "Notification created & sent", notificationId: notification._id, stats });
  } catch (err) {
    console.error("createNotification error", err);
    next(err);
  }
};

/**
 * Get notifications for current user (paginated)
 */
export const getMyNotifications = async (req, res, next) => {
  try {
    const uid = req.user?.id;
    const page = Number(req.query.page || 1);
    const limit = Math.min(Number(req.query.limit || 20), 100);
    if (!uid) return next(createError(401, "Unauthorized"));

    const skip = (page - 1) * limit;
    const notifications = await Notification.find({ "items.user": uid })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean();

    const results = notifications.map(n => {
      const item = n.items.find(it => String(it.user) === String(uid)) || {};
      return {
        id: n._id,
        title: n.title,
        content: n.content,
        html: n.html,
        from: { id: n.sender, role: n.senderRole },
        createdAt: n.createdAt,
        read: !!item.read,
        deliveredAt: item.deliveredAt || null,
        status: n.status
      };
    });

    return res.status(200).json({ notifications: results, page, limit });
  } catch (err) {
    next(err);
  }
};

/**
 * Mark as read
 */
export const markAsRead = async (req, res, next) => {
  try {
    const uid = req.user?.id;
    const { notificationId } = req.params;
    if (!uid) return next(createError(401, "Unauthorized"));
    if (!notificationId) return next(createError(400, "notificationId required"));

    const resu = await Notification.updateOne(
      { _id: notificationId, "items.user": uid },
      { $set: { "items.$.read": true, "items.$.deliveredAt": new Date() } }
    );

    if (resu.matchedCount === 0) return next(createError(404, "Notification not found for user"));

    return res.status(200).json({ message: "Marked read" });
  } catch (err) {
    next(err);
  }
};

/**
 * Get single notification
 */
export const getNotificationById = async (req, res, next) => {
  try {
    const uid = req.user?.id;
    const role = req.user?.role;
    const { id } = req.params;
    if (!uid) return next(createError(401, "Unauthorized"));
    if (!id) return next(createError(400, "Notification id required"));

    const n = await Notification.findById(id).lean();
    if (!n) return next(createError(404, "Notification not found"));

    const isSender = String(n.sender) === String(uid);
    const isAdmin = role === "admin";
    const isRecipient = n.items.some(it => String(it.user) === String(uid));

    if (!isSender && !isAdmin && !isRecipient) {
      return next(createError(403, "Forbidden"));
    }

    let myItem = null;
    if (isRecipient) myItem = n.items.find(it => String(it.user) === String(uid));

    return res.status(200).json({
      id: n._id,
      sender: n.sender,
      senderRole: n.senderRole,
      title: n.title,
      content: n.content,
      html: n.html,
      channels: n.channels,
      target: n.target,
      priority: n.priority,
      estimatedRecipients: n.estimatedRecipients,
      deliveryCount: n.deliveryCount,
      createdAt: n.createdAt,
      itemsCount: n.items.length,
      myItem: myItem ? { read: myItem.read, deliveredAt: myItem.deliveredAt } : null,
      meta: n.meta,
      status: n.status,
      scheduledAt: n.scheduledAt || null
    });
  } catch (err) {
    next(err);
  }
};

/**
 * Admin/staff list notifications with filters
 * Query params:
 *  - department: departmentName (string)
 *  - level: single level or comma-separated levels
 *  - senderRole: filter by role of sender (hod/lecturer)
 *  - senderId: filter by specific sender
 */
export const listNotificationsAdmin = async (req, res, next) => {
  try {
    const callerRole = req.user?.role;
    if (!["lecturer","hod","levelAdviser","dean","subDean","facultyOfficer","admin"].includes(callerRole)) {
      return next(createError(403, "Forbidden"));
    }

    const page = Math.max(1, Number(req.query.page || 1));
    const limit = Math.min(100, Number(req.query.limit || 20));
    const skip = (page - 1) * limit;

    const { department, level, senderRole, senderId } = req.query;
    const filter = {};

    // Department filter logic: include notifications where
    // - target.all === true (general), OR
    // - target.departments contains department (string), OR
    // - sender belongs to that department (so their sends are included)
    if (department) {
      const deptName = String(department).trim();
      // find senders in that department (department is a string on User)
      const senders = await User.find({ department: deptName }).select("_id").lean();
      const senderIds = senders.map(s => s._id);

      filter.$or = [
        { "target.all": true },
        { "target.departments": deptName },
        { sender: { $in: senderIds } }
      ];
    }

    // Level filter: include notifications targeted to those levels OR general
    if (level) {
      const levels = String(level).split(",").map(v => Number(v));
      filter.$and = filter.$and || [];
      filter.$and.push({
        $or: [
          { "target.levels": { $in: levels } },
          { "target.all": true }
        ]
      });
    }

    if (senderRole) filter.senderRole = senderRole;
    if (senderId) filter.sender = senderId;

    const [total, notifications] = await Promise.all([
      Notification.countDocuments(filter),
      Notification.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean()
    ]);

    const results = notifications.map(n => ({
      id: n._id,
      title: n.title,
      content: n.content,
      sender: n.sender,
      senderRole: n.senderRole,
      createdAt: n.createdAt,
      priority: n.priority,
      estimatedRecipients: n.estimatedRecipients,
      deliveryCount: n.deliveryCount,
      status: n.status,
      scheduledAt: n.scheduledAt || null
    }));

    return res.status(200).json({ total, page, limit, results });
  } catch (err) {
    next(err);
  }
};
