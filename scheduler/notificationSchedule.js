// scheduler/scheduledNotifications.js
import Notification from "../model/Notification.js";
import { sendNotificationNow } from "../controller/notification.js";

/**
 * Simple poller to process scheduled notifications.
 * - intervalMs: how often to poll (e.g., 30s)
 */
export const startScheduledNotificationWorker = (intervalMs = 30 * 1000) => {
  console.log("[SCHEDULER] Starting scheduled notification worker, intervalMs=", intervalMs);

  const tick = async () => {
    try {
      const now = new Date();
      // find scheduled notifications ready to run
      const list = await Notification.find({
        status: "scheduled",
        scheduledAt: { $lte: now }
      }).limit(50).lean();

      if (!list || list.length === 0) return;

      console.log(`[SCHEDULER] Found ${list.length} scheduled notifications to process`);

      // Process each (we load the full doc and call sendNotificationNow)
      for (const doc of list) {
        try {
          // load full doc as mongoose doc (to allow updates)
          const notif = await Notification.findById(doc._id);
          if (!notif) continue;
          notif.status = "sending";
          await notif.save();

          const stats = await sendNotificationNow(notif);
          console.log(`[SCHEDULER] Sent scheduled notification ${notif._id}, recipients=${stats.recipientsCount}`);
        } catch (err) {
          console.error("[SCHEDULER] failed to send scheduled notification", doc._id, err);
          // mark failed so you can inspect and retry manually or implement retry logic
          await Notification.findByIdAndUpdate(doc._id, { status: "failed", "meta.lastError": String(err) });
        }
      }
    } catch (err) {
      console.error("[SCHEDULER] unexpected error", err);
    }
  };

  const handle = setInterval(tick, intervalMs);
  // return a function to stop worker
  return () => clearInterval(handle);
};
