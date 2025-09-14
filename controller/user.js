// controllers/users.js
import User from "../model/User.js";
import { createError } from "../error.js";
import bcrypt from "bcryptjs/dist/bcrypt.js";
import mongoose from "mongoose";

/**
 * Helper: sanitize user doc for response
 */
const sanitizeUser = (u) => {
  if (!u) return null;
  const { password, securityQuestions, ...safe } = u;
  return safe;
};

/**
 * Create user (admin / staff can create users).
 * - staff roles allowed: lecturer, hod, levelAdviser, dean, subDean, facultyOfficer, admin
 */
export const createUser = async (req, res, next) => {
  try {
    // Only staff allowed
    const callerRole = req.user?.role;
    const allowed = ["lecturer","hod","levelAdviser","dean","subDean","facultyOfficer","admin"];
    if (!allowed.includes(callerRole)) return next(createError(403, "Forbidden"));

    const {
      name, email, password, role = "student",
      matricNumber, jambRegNumber, level = 100, department, faculty, securityQuestions
    } = req.body;

    // Basic validation similar to signUp
    if (role === "student") {
      if (!level) return next(createError(400,"Level required for student"));
      if (Number(level) !== 100 && !matricNumber) return next(createError(400,"Matric required for >100"));
    } else {
      // staff must provide email
    }

    let passwordHash;
    if (password) {
      const salt = bcrypt.genSaltSync(10);
      passwordHash = bcrypt.hashSync(password, salt);
    }

    const preparedSecurity = [];
    if (Array.isArray(securityQuestions)) {
      for (const sq of securityQuestions.slice(0,2)) {
        if (!sq.question || !sq.answer) continue;
        preparedSecurity.push({
          question: sq.question,
          answerHash: bcrypt.hashSync(String(sq.answer).trim(), 10)
        });
      }
    }

    const newUser = new User({
      name,
      email: email ? String(email).toLowerCase() : undefined,
      password: passwordHash,
      role,
      matricNumber: matricNumber ? String(matricNumber).trim().toUpperCase() : undefined,
      jambRegNumber: jambRegNumber ? String(jambRegNumber).trim().toUpperCase() : undefined,
      level,
      department,
      faculty,
      securityQuestions: preparedSecurity,
      jambRegisteredAt: (!matricNumber && jambRegNumber) ? new Date() : undefined
    });

    const saved = await newUser.save();
    return res.status(201).json({ user: sanitizeUser(saved._doc) });
  } catch (err) {
    if (err.code === 11000) {
      const dupKey = Object.keys(err.keyValue || {})[0];
      return next(createError(400, `${dupKey} already exists`));
    }
    next(err);
  }
};

/**
 * Update user
 * - Students cannot change their role.
 * - Non-admin callers cannot change other user's role.
 * - Users can edit their own profile (except role).
 * - Staff/admin can edit other fields; ensure role protections.
 */
// controllers/users.js (replace updateUser with the following)

export const updateUser = async (req, res, next) => {
  try {
    const callerId = req.user?.id;
    const callerRole = req.user?.role;
    const { id } = req.params; // user to update

    if (!id) return next(createError(400, "User id required"));

    const payload = { ...req.body };

    // Role-change rules:
    // - Students can never change roles (even their own).
    // - Staff (lecturer/hod/levelAdviser/dean/subDean/facultyOfficer) can change roles for others,
    //   but only into other staff roles (not 'student'), and cannot assign 'admin'.
    // - Admin can change any role.
    const staffRoles = ["lecturer","hod","levelAdviser","dean","subDean","facultyOfficer"];
    const allStaffRoles = [...staffRoles, "admin"];

    // If caller is student, disallow any role change
    if (callerRole === "student" && payload.role) {
      return next(createError(403, "Students cannot change roles"));
    }

    // If payload.role exists, validate who can set it
    if (payload.role) {
      const requestedRole = payload.role;

      // If caller is admin, allow any change
      if (callerRole === "admin") {
        // allowed
      } else if (staffRoles.includes(callerRole)) {
        // staff can set roles, but:
        // - cannot set to 'student'
        // - cannot set to 'admin'
        if (requestedRole === "student") {
          return next(createError(403, "Staff cannot change roles to 'student'"));
        }
        if (requestedRole === "admin") {
          return next(createError(403, "Only admin can assign 'admin' role"));
        }
        // allowed if requestedRole is in staffRoles
        if (!allStaffRoles.includes(requestedRole) || requestedRole === "admin") {
          return next(createError(403, "Invalid role requested"));
        }
      } else {
        // other callers (e.g., unauthenticated or unexpected roles) cannot change roles
        return next(createError(403, "Forbidden to change roles"));
      }
    }

    // Prevent a non-admin from editing other users unless they are staff (we allow staff)
    if (callerId !== id && ![...staffRoles, "admin"].includes(callerRole)) {
      return next(createError(403, "Forbidden"));
    }

    // If trying to update password via this route, hash it
    if (payload.password) {
      const salt = bcrypt.genSaltSync(10);
      payload.password = bcrypt.hashSync(payload.password, salt);
    }

    // Prevent non-admin setting admin role
    if (payload.role && payload.role === "admin" && callerRole !== "admin") {
      return next(createError(403, "Cannot assign admin role"));
    }

    // Prevent promoting someone to student (unless admin)
    if (payload.role && payload.role === "student" && callerRole !== "admin") {
      return next(createError(403, "Only admin can change someone to student role"));
    }

    const updated = await User.findByIdAndUpdate(id, payload, { new: true }).select("-password -securityQuestions.answerHash").lean();
    if (!updated) return next(createError(404, "User not found"));

    return res.status(200).json({ user: sanitizeUser(updated) });
  } catch (err) {
    next(err);
  }
};

/**
 * Delete user
 * - Allowed for staff roles (as requested). Admins allowed by default.
 */
export const deleteUser = async (req, res, next) => {
  try {
    const callerRole = req.user?.role;
    const allowed = ["lecturer","hod","levelAdviser","dean","subDean","facultyOfficer","admin"];
    if (!allowed.includes(callerRole)) return next(createError(403, "Forbidden"));

    const { id } = req.params;
    if (!id) return next(createError(400, "User id required"));

    const deleted = await User.findByIdAndDelete(id);
    if (!deleted) return next(createError(404, "User not found"));

    return res.status(200).json({ message: "User deleted" });
  } catch (err) {
    next(err);
  }
};

/**
 * Get single user (admin/staff or self)
 */
export const getUserById = async (req, res, next) => {
  try {
    const callerId = req.user?.id;
    const callerRole = req.user?.role;
    const { id } = req.params;
    if (!id) return next(createError(400, "User id required"));

    // allow if self or staff/admin
    if (callerId !== id && !["lecturer","hod","levelAdviser","dean","subDean","facultyOfficer","admin"].includes(callerRole)) {
      return next(createError(403, "Forbidden"));
    }

    const user = await User.findById(id).select("-password -securityQuestions.answerHash").lean();
    if (!user) return next(createError(404, "User not found"));
    return res.status(200).json({ user: sanitizeUser(user) });
  } catch (err) {
    next(err);
  }
};

/**
 * List users (paginated + filters)
 * Optional filters: role, department, level, q (search name/email/matric)
 */
export const listUsers = async (req, res, next) => {
  try {
    const callerRole = req.user?.role;
    // allow staff and admin to list; students may be allowed to list peers? We'll restrict to staff/admin
    if (!["lecturer","hod","levelAdviser","dean","subDean","facultyOfficer","admin"].includes(callerRole)) {
      return next(createError(403, "Forbidden"));
    }

    const page = Math.max(1, Number(req.query.page || 1));
    const limit = Math.min(100, Number(req.query.limit || 20));
    const skip = (page - 1) * limit;

    const filter = {};
    if (req.query.role) filter.role = req.query.role;
    if (req.query.department) filter.department = req.query.department;
    if (req.query.level) filter.level = Number(req.query.level);

    if (req.query.q) {
      const q = req.query.q.trim();
      filter.$or = [
        { name: { $regex: q, $options: "i" } },
        { email: { $regex: q, $options: "i" } },
        { matricNumber: { $regex: q, $options: "i" } }
      ];
    }

    const [total, users] = await Promise.all([
      User.countDocuments(filter),
      User.find(filter).select("-password -securityQuestions.answerHash").skip(skip).limit(limit).lean()
    ]);

    return res.status(200).json({ total, page, limit, users: users.map(sanitizeUser) });
  } catch (err) {
    next(err);
  }
};
