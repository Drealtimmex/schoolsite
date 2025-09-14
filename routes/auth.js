// routes/auth.js (example)
import express from "express";
import {
  signUp,
  signIn,
  signInWithSecurityAnswers,
  setSecurityQuestions,
  resetPasswordWithAnswers,
  googleAuth,
  signOut
} from "../controller/auth.js";
import { verifyToken } from "../verifyToken.js";

const router = express.Router();

router.post("/signup", signUp);
router.post("/signin", signIn);
router.post("/signin-with-answers", signInWithSecurityAnswers);
router.post("/set-security-questions", verifyToken, setSecurityQuestions); // authenticated
router.post("/reset-password", verifyToken, resetPasswordWithAnswers); // using recovered token
router.post("/reset-password-with-answers", resetPasswordWithAnswers); // supply answers + new password
router.post("/google-auth", googleAuth);
router.post("/signout", verifyToken, signOut);

export default router;
