// models/Notification.js
import mongoose from "mongoose";

const NotificationItemSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  read: { type: Boolean, default: false },
  channelMeta: { type: mongoose.Schema.Types.Mixed, default: {} },
  deliveredAt: { type: Date }
}, { timestamps: true });

const NotificationSchema = new mongoose.Schema({
  sender: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  senderRole: { type: String, required: true },

  title: { type: String },
  content: { type: String, required: true },
  html: { type: String },

  channels: { type: [String], default: ["inapp"] },

  // Targeting: departments are stored as plain strings (e.g. "Computer Science")
  target: {
    all: { type: Boolean, default: false },
    departments: [{ type: String }], // <-- changed to String array
    levels: [{ type: Number }],
    roles: [{ type: String }],
    staffOnly: { type: Boolean, default: false },
    studentsOnly: { type: Boolean, default: false }
  },

  priority: { type: String, enum: ["low", "normal", "high", "emergency"], default: "normal" },

  estimatedRecipients: { type: Number, default: 0 },
  deliveryCount: { type: Number, default: 0 },

  items: { type: [NotificationItemSchema], default: [] },

  meta: { type: mongoose.Schema.Types.Mixed, default: {} },

  // scheduling
  scheduledAt: { type: Date, default: null },

  status: { type: String, enum: ["draft", "scheduled", "queued", "sending", "completed", "failed"], default: "queued" }

}, { timestamps: true });

// useful indexes
NotificationSchema.index({ "items.user": 1, createdAt: -1 });
NotificationSchema.index({ scheduledAt: 1, status: 1 });

export default mongoose.model("Notification", NotificationSchema);
