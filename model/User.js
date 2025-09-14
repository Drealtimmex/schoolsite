// models/User.js
import mongoose from "mongoose";
import bcrypt from "bcryptjs/dist/bcrypt.js";

const SecurityQuestionSchema = new mongoose.Schema({
  question: { type: String, required: true },
  answerHash: { type: String, required: true } // bcrypt hash of the answer
}, { _id: false });

const UserSchema = new mongoose.Schema({
  name: { type: String },
  email: {
    type: String,
    unique: true,
    sparse: true, // allow nulls for students who might not provide email
    lowercase: true,
    trim: true
  },

  // Identifiers for students:
  matricNumber: {
    type: String,
    unique: true,
    sparse: true, // allow missing until student updates matric
    trim: true,
    uppercase: true
  },
  jambRegNumber: {
    type: String,
    unique: true,
    sparse: true,
    trim: true,
    uppercase: true
  },

  // Student-specific metadata
  level: { type: Number, enum: [100, 200, 300, 400, 500, 600], required: true, default: 100 },

  // Department/faculty relation (store id or string)
// models/User.js (excerpt - replace the existing department field)
  // Department/faculty relation (store id or string)
  department: {
    type: String,
    trim: true,
    required: function () {
      // department required for lecturers, HOD, levelAdviser, student and HOD
      const rolesNeedingDept = ["student", "lecturer", "hod", "levelAdviser"];
      return rolesNeedingDept.includes(this.role);
    }
  },
  faculty: { type: String, trim: true, required: false },

  // Password + google flags
  password: { type: String }, // not required for fromGoogle users
  fromGoogle: { type: Boolean, default: false },
  googleId: { type: String },

  // Role enum & default
  role: {
    type: String,
    enum: ["student", "lecturer", "hod", "levelAdviser", "dean", "subDean", "facultyOfficer", "admin"],
    default: "student"
  },

  // security questions (two answers recommended)
  securityQuestions: {
    type: [SecurityQuestionSchema],
    default: []
  },

  // if student used jamb at signup
  jambRegisteredAt: { type: Date },

  // device tokens (for push notifications)
  deviceTokens: [{
    provider: { type: String }, // 'fcm', 'webpush', etc
    token: { type: String },
    addedAt: { type: Date, default: Date.now }
  }],

  // other metadata
  phoneNumber: { type: String },
  isActive: { type: Boolean, default: true },

  // for password reset via token if you want both flows later
  resetPasswordToken: { type: String },
  resetPasswordTokenExpiry: { type: Date },

  // geolocation example (you had it):
  location: {
    type: { type: String, enum: ["Point"], default: "Point" },
    coordinates: { type: [Number], default: [0, 0] }
  }
}, { timestamps: true });

// 2dsphere index for location queries
UserSchema.index({ location: "2dsphere" });

// Helpful instance methods

// compare given password with hashed password
UserSchema.methods.comparePassword = async function (candidate) {
  if (!this.password) return false;
  return bcrypt.compare(candidate, this.password);
};

// verify security answers (expects array of plain answers in same order)
// In models/User.js (replace verifySecurityAnswers method)

// models/User.js (only the updated method shown — replace existing verifySecurityAnswers)

UserSchema.methods.verifySecurityAnswers = async function (answers = []) {
  // stored security questions (array of { question, answerHash })
  const stored = this.securityQuestions || [];

  if (!stored || stored.length === 0) return false;

  // Two accepted input shapes:
  // 1) array of strings: ["ans1","ans2"] -> order-dependent (must match stored order)
  // 2) array of objects: [{ question, answer }, ...] -> order-independent (match by question text)
  if (!Array.isArray(answers) || answers.length === 0) return false;

  // Helper to compare a plain answer with a stored answerHash
  const compareAnswer = async (plain, answerHash) => {
    if (typeof plain === "undefined" || plain === null) return false;
    return await bcrypt.compare(String(plain).trim(), answerHash);
  };

  // Case A: array of strings (order dependent)
  const allStrings = answers.every(a => typeof a === "string");
  if (allStrings) {
    if (answers.length !== stored.length) return false; // require same length to avoid ambiguity
    for (let i = 0; i < stored.length; i++) {
      const ok = await compareAnswer(answers[i], stored[i].answerHash);
      if (!ok) return false;
    }
    return true;
  }

  // Case B: array of { question, answer } objects (order independent)
  const allObjects = answers.every(a => a && typeof a === "object" && ("question" in a) && ("answer" in a));
  if (allObjects) {
    // build a map of stored question -> answerHash (normalize question text)
    const map = new Map();
    for (const s of stored) {
      if (!s || !s.question) continue;
      map.set(String(s.question).trim().toLowerCase(), s.answerHash);
    }

    // For each provided pair, find matching stored question and compare
    for (const pair of answers) {
      const q = String(pair.question).trim().toLowerCase();
      const plain = pair.answer;
      const answerHash = map.get(q);
      if (!answerHash) return false; // unknown question
      const ok = await compareAnswer(plain, answerHash);
      if (!ok) return false;
    }

    // Passed all provided pairs. Optionally require that user supplied exactly the stored count
    // (to avoid partial match). Enforce that here:
    if (answers.length !== stored.length) return false;

    return true;
  }

  // Unsupported input shape
  return false;
};


// pre-save: lowercase email
UserSchema.pre("save", function (next) {
  if (this.email) this.email = this.email.toLowerCase();
  next();
});

export default mongoose.model("User", UserSchema);
