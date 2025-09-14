import express from "express";
import { verifyToken, requireRole } from "../verifyToken.js";
import {
  createUser,
  updateUser,
  deleteUser,
  getUserById,
  listUsers,
} from "../controller/user.js";

const router = express.Router();

/**
 * Users Routes
 * All routes here are protected — must have a valid JWT.
 * Some routes restricted to staff/admin roles only.
 */

// Create new user (staff/admin only)
router.post("/", verifyToken, requireRole([
  "lecturer","hod","levelAdviser","dean","subDean","facultyOfficer","admin"
]), createUser);

// Update user (self or staff/admin with rules inside controller)
router.put("/:id", verifyToken, updateUser);

// Delete user (staff/admin only)
router.delete("/:id", verifyToken, requireRole([
  "lecturer","hod","levelAdviser","dean","subDean","facultyOfficer","admin"
]), deleteUser);

// Get user by ID (self or staff/admin)
router.get("/:id", verifyToken, getUserById);

// List users (staff/admin only)
router.get("/", verifyToken, requireRole([
  "lecturer","hod","levelAdviser","dean","subDean","facultyOfficer","admin"
]), listUsers);

export default router;
