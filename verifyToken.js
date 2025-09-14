// middleware/verifyToken.js
import jwt from "jsonwebtoken";
import { createError } from "./error.js";
import User from "./model/User.js";

/**
 * Extract token from either:
 *  - Authorization header: "Bearer <token>" (preferred if present)
 *  - or cookie named access_token
 */
const extractToken = (req) => {
  // 1) Authorization header (explicit, used by mobile / API clients)
  const authHeader = req.headers?.authorization;
  if (authHeader && typeof authHeader === "string" && authHeader.startsWith("Bearer ")) {
    return authHeader.split(" ")[1].trim();
  }

  // 2) Cookie fallback (browser flows)
  if (req.cookies && req.cookies.access_token) {
    return req.cookies.access_token;
  }

  return null;
};

/**
 * verifyToken middleware
 * - attaches req.user = { id, role, recovered?, iat, exp }
 * - optionally attaches req.userDoc (uncomment `LOAD_USER_DOC` to enable)
 */
export const verifyToken = async (req, res, next) => {
  try {
    const token = extractToken(req);
    if (!token) return next(createError(401, "You are not authenticated. Token missing."));

    let payload;
    try {
      payload = jwt.verify(token, process.env.JWT);
    } catch (err) {
      // token invalid or expired
      return next(createError(403, "Token is not valid or has expired."));
    }

    // Ensure payload has expected shape (id at minimum)
    if (!payload || !payload.id) return next(createError(401, "Invalid token payload."));

    // Attach minimal user info to request
    req.user = {
      id: payload.id,
      role: payload.role || null,
      // some flows might set recovered: true (e.g. signInWithSecurityAnswers)
      recovered: payload.recovered || false,
      iat: payload.iat,
      exp: payload.exp
    };

    // OPTIONAL: Load full user doc for convenience.
    // Pros: easier access to user fields (department, level, preferences) inside controllers.
    // Cons: extra DB hit on every authenticated request.
    const LOAD_USER_DOC = true; // set to false to disable automatic DB lookup
    if (LOAD_USER_DOC) {
      try {
        const userDoc = await User.findById(payload.id).select("-password -securityQuestions.answerHash").lean();
        if (!userDoc) return next(createError(401, "User not found."));
        req.userDoc = userDoc;
        // ensure req.user.role exists (fallback to DB value if not present in token)
        if (!req.user.role && userDoc.role) req.user.role = userDoc.role;
      } catch (err) {
        // DB error — fail closed (deny access) or choose to ignore and allow? we deny here.
        return next(createError(500, "Failed to load user data."));
      }
    }

    next();
  } catch (err) {
    next(err);
  }
};

/**
 * Role-check middleware factory
 * Usage: requireRole(['admin','dean'])
 */
export const requireRole = (allowedRoles = []) => (req, res, next) => {
  if (!req.user) return next(createError(401, "Unauthorized"));
  if (!Array.isArray(allowedRoles) || allowedRoles.length === 0) return next();
  if (!allowedRoles.includes(req.user.role)) return next(createError(403, "Forbidden"));
  next();
};
