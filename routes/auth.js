// routes/auth.js
import express from "express";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import fs from "fs";
import path from "path";

import { authenticate } from "../middleware/auth.js";


const users = [];

const router = express.Router();
router.get("/me", authenticate, (req, res) => {
    res.json({ email: req.user.email });
  });
const USERS_FILE = path.join(process.cwd(), "users.json");
const JWT_SECRET = process.env.JWT_SECRET || "macbridge_secret"; // Use env in production

// Ensure user data file exists
if (!fs.existsSync(USERS_FILE)) fs.writeFileSync(USERS_FILE, "[]");

// Helper to read/write users
const readUsers = () => JSON.parse(fs.readFileSync(USERS_FILE));
const writeUsers = (users) => fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));

// Register
router.post("/register", async (req, res) => {
    const { email, password } = req.body;
    const users = readUsers();

    if (users.find((u) => u.email === email))
        return res.status(400).json({ message: "Email already exists" });

    const hashed = await bcrypt.hash(password, 10);
    users.push({ email, password: hashed });
    writeUsers(users);

    res.json({ message: "User registered" });
});

// Login
router.post("/login", async (req, res) => {
    const { email, password } = req.body;
    const users = readUsers();  // FIXED: load users from file
  
    const user = users.find(u => u.email === email);
    if (!user) return res.status(400).json({ message: "Invalid credentials" });
  
    console.log("User found:", user);
    console.log("Entered password:", password);
    console.log("Stored hash:", user.password);
  
    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) return res.status(400).json({ message: "Invalid credentials" });
  
    // Generate JWT
    const token = jwt.sign({ email: user.email }, JWT_SECRET, { expiresIn: "7d" });
  
    res.json({ message: "Login successful", token });
  });
export default router;