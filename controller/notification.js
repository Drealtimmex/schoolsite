// controllers/notifications.js
import Notification from "../model/Notification.js";
import User from "../model/User.js";
import { emitToUser, emitToRole } from "../config/socket.js";
import mongoose from "mongoose";
import { createError } from "../error.js";

/** helper - normalize department strings */
const normalizeDept = (d) => {
  if (d === undefined || d === null) return d;
  return String(d).trim().toLowerCase();
};

/** helper - normalize role for comparisons */
const normalizeRole = (r) => String(r || "").toLowerCase();

/**
 * Build recipient query - departments are plain strings
 */
const buildRecipientQuery = async ({ sender, senderRole, target = {} }) => {
  const q = { isActive: true };

  // roles logic
  if (Array.isArray(target.roles) && target.roles.length > 0) {
    q.role = { $in: target.roles };
  } else {
    if (target.studentsOnly && !target.staffOnly) {
      q.role = "student";
    } else if (target.staffOnly && !target.studentsOnly) {
      q.role = { $in: ["lecturer", "hod", "levelAdviser", "dean", "subDean", "facultyOfficer", "admin"] };
    }
  }

  // if all -> return q
  if (target.all) return q;

  // department filtering (strings)
  if (Array.isArray(target.departments) && target.departments.length > 0) {
    const depts = target.departments.map(normalizeDept).filter(Boolean);
    if (depts.length > 0) q.department = { $in: depts };
  } else {
    const deptScoped = ["lecturer", "hod", "leveladviser"];
    if (deptScoped.includes(normalizeRole(senderRole)) && sender?.department) {
      q.department = normalizeDept(sender.department);
    }
  }

  // levels
  if (Array.isArray(target.levels) && target.levels.length > 0) {
    q.level = { $in: target.levels.map(Number) };
  }

  return q;
};

/** helper - parse & validate scheduledAt: return Date if valid future date, else null */
const parseValidScheduledAt = (raw) => {
  if (!raw && raw !== 0) return null; // undefined/null/"" => treat as no schedule
  const d = new Date(raw);
  if (isNaN(d.getTime())) return null;
  // require it be in the future (>= now + 1 second)
  if (d.getTime() <= Date.now() + 1000) return null;
  return d;
};

/**
 * sendNotificationNow - resolves recipients, emits to socket.io, and updates notification.
 * Lots of logs added so you can inspect runtime behaviour.
 */
export const sendNotificationNow = async (notification) => {
  try {
    const notifId = notification._id ?? notification.id ?? String(Math.random());
    console.log('[sendNotificationNow] ENTER', notifId);

    let recipients = [];

    // 1) explicit items -> resolve users
    if (Array.isArray(notification.items) && notification.items.length > 0) {
      const userIds = notification.items.map(it => it.user).filter(Boolean);
      console.log('[sendNotificationNow] resolving recipients from explicit items, count=', userIds.length);
      recipients = await User.find({ _id: { $in: userIds } }).select("_id name email deviceTokens role department level").lean();
    } else {
      // 2) target-based resolution
      const sender = await User.findById(notification.sender).select("_id department role name email level").lean();
      if (!sender) {
        notification.status = "failed";
        notification.meta = { lastError: "sender_not_found" };
        await notification.save();
        console.error('[sendNotificationNow] sender not found:', String(notification.sender));
        return { recipientsCount: 0, emittedSockets: 0 };
      }

      const recipientQuery = await buildRecipientQuery({ sender, senderRole: notification.senderRole, target: notification.target || {} });

      if (notification.target?.studentsOnly) recipientQuery.role = "student";
      else if (notification.target?.staffOnly) recipientQuery.role = { $in: ["lecturer","hod","levelAdviser","dean","subDean","facultyOfficer","admin"] };

      console.log('[sendNotificationNow] recipientQuery:', JSON.stringify(recipientQuery));
      recipients = await User.find(recipientQuery).select("_id name email deviceTokens role department level").lean();

      // persist items (so getMyNotifications works)
      try {
        notification.items = recipients.map(r => ({ user: r._id }));
        await notification.save();
      } catch (err) {
        console.warn('[sendNotificationNow] warning: failed to persist items to notification (non-fatal)', err);
      }
    }

    // dedupe recipients
    const seen = new Set();
    recipients = recipients.filter(r => {
      const id = String(r._id);
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    });

    console.log('[sendNotificationNow] recipients resolved, count=', recipients.length, 'sample=', recipients.slice(0,5).map(r => String(r._id)));

    // prepare createdAt (ISO)
    const createdAtIso = (notification.createdAt && notification.createdAt.toISOString) ? notification.createdAt.toISOString() : new Date().toISOString();

    // emit to each recipient using emitToUser (which should return number of sockets)
    let emittedSockets = 0;
    for (const r of recipients) {
      try {
        const payload = {
          notificationId: notification._id,
          title: notification.title,
          content: notification.content,
          from: { id: notification.sender, role: notification.senderRole },
          createdAt: createdAtIso
        };

        console.log(`[sendNotificationNow] emitting -> user ${r._id} payload summary:`, { notificationId: payload.notificationId, title: payload.title, createdAt: payload.createdAt });

        const emitted = emitToUser(String(r._id), "notification:new", payload);
        console.log(`[sendNotificationNow] emitToUser returned ${emitted} for user ${r._id}`);
        emittedSockets += (Number(emitted) || 0);
      } catch (err) {
        console.error("emit error for user", r._id, err);
      }
    }

    // emit to roles (if target.roles provided)
    if (Array.isArray(notification.target?.roles) && notification.target.roles.length > 0) {
      for (const role of notification.target.roles) {
        try {
          const payload = {
            notificationId: notification._id,
            title: notification.title,
            content: notification.content,
            from: { id: notification.sender, role: notification.senderRole },
            createdAt: createdAtIso
          };
          console.log(`[sendNotificationNow] emitting to role ${role}`);
          const emitted = emitToRole(role, "notification:new", payload);
          console.log(`[sendNotificationNow] emitToRole returned ${emitted} for role ${role}`);
          emittedSockets += (Number(emitted) || 0);
        } catch (err) {
          console.error("emit to role error", role, err);
        }
      }
    }

    console.log('[sendNotificationNow] emit summary -> recipients=', recipients.length, 'emittedSockets=', emittedSockets);

    // Optionally update deliveredAt for persisted items (best-effort)
    try {
      if (recipients.length > 0) {
        const recipientIds = recipients.map(r => r._id);
        // Set deliveredAt on matched items using arrayFilters
        await Notification.updateOne(
          { _id: notification._id },
          { $set: { "items.$[elem].deliveredAt": new Date() } },
          { arrayFilters: [{ "elem.user": { $in: recipientIds } }], multi: false }
        );
        console.log('[sendNotificationNow] updated items.deliveredAt for matched recipients');
      }
    } catch (err) {
      console.warn('[sendNotificationNow] warning: failed to update items.deliveredAt (non-fatal)', err);
    }

    // finalize notification record
    notification.status = "completed";
    notification.deliveryCount = recipients.length;
    try {
      await notification.save();
    } catch (err) {
      console.warn('[sendNotificationNow] warning: failed to save notification status/deliveryCount', err);
    }

    return { recipientsCount: recipients.length, emittedSockets };
  } catch (err) {
    console.error('[sendNotificationNow] UNCAUGHT ERROR', err);
    try {
      notification.status = "failed";
      notification.meta = { lastError: err.message || String(err) };
      await notification.save();
    } catch (saveErr) {
      console.error('[sendNotificationNow] failed to set notification.status on error', saveErr);
    }
    return { recipientsCount: 0, emittedSockets: 0, error: String(err) };
  }
};

/**
 * createNotification - immediate or scheduled
 */
export const createNotification = async (req, res, next) => {
  try {
    console.log('>>> createNotification called, body=', req.body);

    const senderId = req.user?.id;
    const senderRoleFromToken = req.user?.role;
    if (!senderId) {
      console.log('>>> createNotification: unauthorized (no senderId)');
      return next(createError(401, "Unauthorized"));
    }

    const { title, content, html, channels = ["inapp"], target = {}, priority = "normal", meta = {}, scheduledAt } = req.body;
    if (!content) return next(createError(400, "Content required"));

    // Use the preloaded user doc if available (avoid additional find if not needed)
    let sender = req.userDoc;
    if (!sender) {
      sender = await User.findById(senderId).select("_id department role name email level").lean();
    }

    if (!sender) return next(createError(400, "Sender not found"));

    // Block students from sending
    const senderRoleNorm = normalizeRole(sender.role || senderRoleFromToken);
    const ALLOWED_SENDER_ROLES = ["lecturer","hod","leveladviser","dean","subdean","facultyofficer","admin"];
    if (!ALLOWED_SENDER_ROLES.includes(senderRoleNorm)) {
      return next(createError(403, "Forbidden: only staff can create notifications"));
    }

    // LevelAdviser default level behavior (if target.levels missing)
    if (senderRoleNorm === "leveladviser" && (!Array.isArray(target.levels) || target.levels.length === 0) && sender.level) {
      target.levels = [sender.level];
    }

    // default target behavior if not provided
    const staffRolesNoDeptAllowed = ["dean", "subdean", "admin"];
    if (!target || Object.keys(target).length === 0) {
      if (staffRolesNoDeptAllowed.includes(senderRoleNorm)) {
        target.all = true;
        target.studentsOnly = true;
      } else {
        target.studentsOnly = true;
      }
    }

    // Normalize department strings in target if provided
    if (Array.isArray(target.departments) && target.departments.length > 0) {
      target.departments = target.departments.map(d => normalizeDept(d)).filter(Boolean);
    }

    // Validate scheduledAt: only accept a real future date
    const scheduledDate = parseValidScheduledAt(scheduledAt);
    if (scheduledAt && !scheduledDate) {
      console.warn('createNotification: scheduledAt provided but invalid or not in future, treating as immediate:', scheduledAt);
    }

    // Create notification document
    const notification = new Notification({
      sender: sender._id,
      senderRole: sender.role || senderRoleFromToken,
      title,
      content,
      html,
      channels,
      target,
      priority,
      meta,
      status: scheduledDate ? "scheduled" : "queued",
      scheduledAt: scheduledDate ? scheduledDate : undefined
    });

    await notification.save();
    console.log('createNotification: notification saved', String(notification._id), 'scheduledAt=', notification.scheduledAt);

    if (scheduledDate) {
      console.log('createNotification: scheduling notification for', scheduledDate.toISOString());
      return res.status(201).json({ message: "Notification scheduled", notificationId: notification._id, scheduledAt: notification.scheduledAt });
    }

    console.log('createNotification: calling sendNotificationNow for', String(notification._id));
    const stats = await sendNotificationNow(notification);
    console.log('createNotification: sendNotificationNow returned', stats);

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

    if (resu.matchedCount === 0 && resu.nModified === 0) return next(createError(404, "Notification not found for user"));

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

    if (department) {
      const deptName = String(department).trim();
      const senders = await User.find({ department: deptName }).select("_id").lean();
      const senderIds = senders.map(s => s._id);

      filter.$or = [
        { "target.all": true },
        { "target.departments": deptName },
        { sender: { $in: senderIds } }
      ];
    }

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
