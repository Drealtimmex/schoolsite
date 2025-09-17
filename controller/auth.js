// controllers/auth.js
import bcrypt from "bcryptjs/dist/bcrypt.js";
import jwt from "jsonwebtoken";
import User from "../model/User.js";
import { createError } from "../error.js";

/**
 * Utility: create cookie options
 */
const cookieOpts = () => ({
  httpOnly: true,
  secure: process.env.NODE_ENV === "production", // true in production, false in dev
  sameSite: process.env.NODE_ENV === "production" ? "none" : "lax",
  maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
  path: "/"
});

/**
 * Create an access token (short/long life depending on purpose)
 */
const createAccessToken = (payload, opts = { expiresIn: "30d" }) => {
  return jwt.sign(payload, process.env.JWT, { expiresIn: opts.expiresIn });
};

/**
 * signUp
 */
// controllers/auth.js (imports expected at top of file)
// import bcrypt from "bcryptjs/dist/bcrypt.js";
// import jwt from "jsonwebtoken"; // if you implement createAccessToken yourself
// import User from "../models/User.js";
// import { createError } from "../error.js";
// // cookieOpts() and createAccessToken() should already exist in this file

export const signUp = async (req, res, next) => {
  try {
    const {
      name,
      email,
      password,
      role = "student",
      matricNumber,
      jambRegNumber,
      level = 100,
      department,
      securityQuestions // optional: user can submit chosen questions+answers at signup
    } = req.body || {};

    if (!role) return next(createError(400, "Role is required"));

    // normalize role string for comparisons
    const roleNorm = String(role).trim().toLowerCase();

    const staffRoles = ["lecturer", "hod", "leveladviser","facualtyPRO", "dean", "subdean", "facultyofficer", "admin"];
    const isStaff = staffRoles.includes(roleNorm);

    // staff must provide email (except you can change this if needed)
    if (isStaff && !email) return next(createError(400, "Email is required for staff accounts"));

    // Student validation (unchanged)
    if (roleNorm === "student") {
      if (!level) return next(createError(400, "Level is required for student"));
      if (Number(level) === 100 && !matricNumber && !jambRegNumber) {
        return next(createError(400, "Level 100 students must provide jambRegNumber or matricNumber"));
      }
      if (Number(level) !== 100 && !matricNumber) {
        return next(createError(400, "Students above level 100 must provide matricNumber"));
      }
    }

    // Enforce department/level rules for specific staff roles:
    // - levelAdviser: requires department AND level
    // - lecturer: requires department
    // - hod: requires department
    // dean/subDean/facultyOfficer/admin do NOT require department
    if (roleNorm === "leveladviser") {
      if (!department) return next(createError(400, "Level adviser must provide a department"));
      if (!level) return next(createError(400, "Level adviser must provide a level"));
    }

    if (roleNorm === "lecturer" && !department) {
      return next(createError(400, "Lecturers must set a department"));
    }

    if (roleNorm === "hod" && !department) {
      return next(createError(400, "HOD must set a department"));
    }

    // Hash password if provided
    let passwordHash = undefined;
    if (password) {
      const salt = bcrypt.genSaltSync(10);
      passwordHash = bcrypt.hashSync(password, salt);
    }

    // Hash provided security questions (if given)
    const preparedSecurity = [];
    if (Array.isArray(securityQuestions)) {
      for (const sq of securityQuestions.slice(0, 2)) {
        if (!sq?.question || !sq?.answer) continue;
        const answerHash = bcrypt.hashSync(String(sq.answer).trim(), 10);
        preparedSecurity.push({ question: sq.question, answerHash });
      }
    }

    // Normalize department & faculty to plain lowercase strings (if provided)
    const deptNormalized = department ? String(department).trim().toLowerCase() : undefined;
   

    const newUser = new User({
      name,
      email: email ? String(email).toLowerCase() : undefined,
      password: passwordHash,
      role: roleNorm, // save normalized role
      matricNumber: matricNumber ? String(matricNumber).trim().toUpperCase() : undefined,
      jambRegNumber: jambRegNumber ? String(jambRegNumber).trim().toUpperCase() : undefined,
      level,
      department: deptNormalized,
      securityQuestions: preparedSecurity,
      fromGoogle: false,
      jambRegisteredAt: (!matricNumber && jambRegNumber) ? new Date() : undefined
    });

    const saved = await newUser.save();

    // Do not return sensitive fields
    const { password: _, securityQuestions: __, ...safe } = saved._doc;

    // Create token and set cookie + return token in JSON (useful for mobile)
     return res.status(201).json({ user: safe, });
  } catch (err) {
    // Duplicate key (unique) handling
    if (err && err.code === 11000) {
      const dupKey = Object.keys(err.keyValue || {})[0];
      return next(createError(400, `${dupKey} already exists`));
    }
    next(err);
  }
};


/**
 * signIn
 */
export const signIn = async (req, res, next) => {
  try {
    const { email, matricNumber, jambRegNumber, password } = req.body;

    if (!email && !matricNumber && !jambRegNumber) {
      return next(createError(400, "Provide email or matricNumber or jambRegNumber to sign in"));
    }

    // Find user by identifier
    let user;
    if (email) user = await User.findOne({ email: email.toLowerCase() });
    else if (matricNumber) user = await User.findOne({ matricNumber: String(matricNumber).trim().toUpperCase() });
    else if (jambRegNumber) user = await User.findOne({ jambRegNumber: String(jambRegNumber).trim().toUpperCase() });

    if (!user) return next(createError(404, "User not found"));

    if (!user.password && user.fromGoogle) {
      return next(createError(401, "This account uses Google sign-in. Use Google login."));
    }

    if (!password) {
      return next(createError(400, "Password required. If you forgot password use /signin-with-answers."));
    }

    const passwordOk = await bcrypt.compare(password, user.password);
    if (!passwordOk) return next(createError(400, "Wrong credentials"));

    // Optional reminder logic for jamb->matric 6 months — we don't block login
    if (user.role === "student" && Number(user.level) === 100 && user.jambRegisteredAt && !user.matricNumber) {
      const sixMonths = 1000 * 60 * 60 * 24 * 30 * 6;
      if (Date.now() - new Date(user.jambRegisteredAt).getTime() > sixMonths) {
        // The client may show a warning if you include a flag in the response
      }
    }

    // Generate token, set cookie, and return token in JSON
    const accessToken = createAccessToken({ id: user._id, role: user.role }, { expiresIn: "30d" });
    const { password: _, securityQuestions: __, ...others } = user._doc;

    res.cookie("access_token", accessToken, cookieOpts())
      .status(200)
      .json({ user: others, accessToken });
  } catch (err) {
    next(err);
  }
};

/**
 * signInWithSecurityAnswers
 * - Accepts identifier + answers[] (user-provided chosen answers). Issues short-lived accessToken with recovered:true
 */
// controllers/auth.js (only signInWithSecurityAnswers replaced)
// controllers/auth.js — corrected signInWithSecurityAnswers

export const signInWithSecurityAnswers = async (req, res, next) => {
  try {
    const { email, matricNumber, jambRegNumber, answers } = req.body;

    if (!email && !matricNumber && !jambRegNumber) {
      return next(createError(400, "Provide an identifier (email, matricNumber or jambRegNumber)"));
    }

    if (!Array.isArray(answers) || answers.length === 0) {
      return next(createError(400, "Provide security answers (array)."));
    }

    // Load user
    let user;
    if (email) user = await User.findOne({ email: email.toLowerCase() });
    else if (matricNumber) user = await User.findOne({ matricNumber: String(matricNumber).trim().toUpperCase() });
    else if (jambRegNumber) user = await User.findOne({ jambRegNumber: String(jambRegNumber).trim().toUpperCase() });

    if (!user) return next(createError(404, "User not found"));

    if (!user.securityQuestions || user.securityQuestions.length === 0) {
      return next(createError(400, "No security questions set for this account"));
    }

    // Require the caller to provide exactly the number of answers we have stored
    const expectedCount = user.securityQuestions.length;
    if (answers.length !== expectedCount) {
      return next(createError(400, `You must provide ${expectedCount} answer(s)`));
    }

    // verifySecurityAnswers handles both ["ans1","ans2"] and [{question,answer},...]
    const ok = await user.verifySecurityAnswers(answers);
    if (!ok) return next(createError(401, "Security answers do not match"));

    // Issue short-lived token (recovered:true) so client can call reset-password
    const accessToken = createAccessToken({ id: user._id, role: user.role, recovered: true }, { expiresIn: "1h" });

    // Set cookie and return token in JSON
    res.cookie("access_token", accessToken, {
      ...cookieOpts(),
      maxAge: 60 * 60 * 1000 // 1 hour
    }).status(200).json({ message: "Authenticated via security answers. Please reset password.", accessToken });
  } catch (err) {
    next(err);
  }
};


/**
 * setSecurityQuestions
 * - Authenticated route: user picks ANY 2 questions from the question bank and provides answers.
 */
export const setSecurityQuestions = async (req, res, next) => {
  try {
    const userId = req.user?.id;
    if (!userId) return next(createError(401, "Unauthorized"));
    const { securityQuestions } = req.body; // [{ question, answer }, ...] expect 2

    if (!Array.isArray(securityQuestions) || securityQuestions.length < 2) {
      return next(createError(400, "Provide at least two security questions and answers"));
    }

    const prepared = securityQuestions.slice(0, 2).map(sq => ({
      question: sq.question,
      answerHash: bcrypt.hashSync(String(sq.answer).trim(), 10)
    }));

    const user = await User.findByIdAndUpdate(userId, { securityQuestions: prepared }, { new: true }).select("-password");
    const { password: _, securityQuestions: __, ...safe } = user._doc;
    res.status(200).json({ message: "Security questions set", user: safe });
  } catch (err) {
    next(err);
  }
};

/**
 * resetPasswordWithAnswers
 * - Accepts either:
 *    A) an authenticated short-lived token (recovered:true) issued by signInWithSecurityAnswers (cookie or header), OR
 *    B) identifier + answers + newPassword in a single request
 */
export const resetPasswordWithAnswers = async (req, res, next) => {
  try {
    const { email, matricNumber, jambRegNumber, answers, newPassword } = req.body;
    if (!newPassword) return next(createError(400, "New password is required"));

    // If user has JWT with recovered flag, allow directly
    const authUser = req.user;
    let user;
    if (authUser && authUser.recovered && authUser.id) {
      user = await User.findById(authUser.id);
      if (!user) return next(createError(404, "User not found"));
    } else {
      // otherwise require identifier + answers
      if (!email && !matricNumber && !jambRegNumber) return next(createError(400, "Provide an identifier"));
      if (!Array.isArray(answers) || answers.length < 2) return next(createError(400, "Provide two answers"));

      if (email) user = await User.findOne({ email: email.toLowerCase() });
      else if (matricNumber) user = await User.findOne({ matricNumber: String(matricNumber).trim().toUpperCase() });
      else if (jambRegNumber) user = await User.findOne({ jambRegNumber: String(jambRegNumber).trim().toUpperCase() });

      if (!user) return next(createError(404, "User not found"));
      const ok = await user.verifySecurityAnswers(answers);
      if (!ok) return next(createError(401, "Security answers do not match"));
    }

    // update password
    const salt = bcrypt.genSaltSync(10);
    const hash = bcrypt.hashSync(newPassword, salt);
    user.password = hash;
    // clear any recovered flag fields if you use them
    await user.save();

    // respond: create a new long-lived token and set cookie + return accessToken
    const accessToken = createAccessToken({ id: user._id, role: user.role }, { expiresIn: "30d" });
    res.cookie("access_token", accessToken, cookieOpts()).status(200).json({ message: "Password updated", accessToken });
  } catch (err) {
    next(err);
  }
};

/**
 * googleAuth
 */
export const googleAuth = async (req, res, next) => {
  try {
    const { email, googleId, name } = req.body;
    if (!email || !googleId) return next(createError(400, "Email and googleId required"));

    let user = await User.findOne({ email: email.toLowerCase() });
    if (user) {
      const accessToken = createAccessToken({ id: user._id, role: user.role }, { expiresIn: "30d" });
      return res.cookie("access_token", accessToken, cookieOpts()).status(200).json({ user: user._doc, accessToken });
    }

    // create new google user
    const newUser = new User({
      email: email.toLowerCase(),
      googleId,
      fromGoogle: true,
      name,
      role: "student"
    });

    const saved = await newUser.save();
    const accessToken = createAccessToken({ id: saved._id, role: saved.role }, { expiresIn: "30d" });
    res.cookie("access_token", accessToken, cookieOpts()).status(201).json({ user: saved._doc, accessToken });
  } catch (err) {
    next(err);
  }
};

/**
 * signOut - clear cookie
 */
export const signOut = async (req, res, next) => {
  try {
    res.clearCookie("access_token", {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: process.env.NODE_ENV === "production" ? "none" : "lax",
      path: "/"
    });
    res.status(200).json({ message: "Logged out" });
  } catch (err) {
    next(err);
  }
};
