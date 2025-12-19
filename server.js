import express from "express";
import cors from "cors";
import multer from "multer";
import { google } from "googleapis";
import path from "path";
import fs from "fs";
import authRoutes from "./routes/auth.js";
import { WebSocketServer } from "ws";

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use("/api/auth", authRoutes);

// Google Auth with env var (recommended)
let drive;
try {
  const credentials = JSON.parse(process.env.GOOGLE_DRIVE_KEY);
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/drive"],
  });
  drive = google.drive({ version: "v3", auth });
  console.log("[Auth] Google Drive client initialized successfully");
} catch (err) {
  console.error("[Auth] Failed to initialize Google Drive:", err.message);
  // App can still run, but uploads will fail
}

const DRIVE_FOLDER_ID = "1olOvZZbvGuyzoB-9L1d8sZXe9iEzauOA";

// Multer with size limit (100MB) to prevent timeouts
const upload = multer({
  dest: "uploads/",
  limits: { fileSize: 100 * 1024 * 1024 }, // 100MB
});

let pendingJobs = [];
let activeJobs = [];
let completedJobs = [];

// WebSocket setup
const wss = new WebSocketServer({ noServer: true });
let clients = [];

wss.on("connection", (ws) => {
  clients.push(ws);
  ws.on("close", () => {
    clients = clients.filter((client) => client !== ws);
  });
});

function broadcastLog(job_id, message) {
  const payload = JSON.stringify({ job_id, message });
  clients.forEach((client) => {
    if (client.readyState === 1) client.send(payload);
  });
}

global.broadcastLog = broadcastLog;

// Server
const server = app.listen(PORT, () => {
  console.log(`MacBridge API running on port ${PORT}`);
});

server.on("upgrade", (req, socket, head) => {
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit("connection", ws, req);
  });
});

// Global error handler
app.use((err, req, res, next) => {
  console.error("[Global Error]", err.stack);
  res.status(500).json({ error: "Internal server error" });
});

// Routes
app.get("/jobs/next", (req, res) => {
  if (pendingJobs.length === 0) return res.json({ job_id: null });
  const job = pendingJobs.shift();
  console.log("[Server] Job sent to agent:", job.job_id);
  res.json(job);
});

app.post("/jobs/result", (req, res) => {
  const { job_id, status, output_url, error } = req.body;
  const matched = activeJobs.find((j) => j.job_id === job_id);
  const email = matched?.email || "unknown@example.com";

  completedJobs.push({
    job_id,
    status,
    output_url,
    error,
    email,
    timestamp: new Date().toISOString(),
  });
  activeJobs = activeJobs.filter((j) => j.job_id !== job_id);
  res.json({ message: "Result received" });
});

app.post("/jobs/upload", upload.single("job"), async (req, res) => {
  try {
    if (!drive) throw new Error("Google Drive client not initialized");

    const { build_mode = "simulator", webhook_url = null, email = "anonymous@example.com" } = req.body;

    if (!req.file) throw new Error("No file uploaded");

    const filePath = req.file.path;
    console.log("[Upload] File received:", filePath, "size:", req.file.size);

    const fileMetadata = {
      name: req.file.originalname,
      parents: [DRIVE_FOLDER_ID],
    };
    const media = {
      mimeType: "application/zip",
      body: fs.createReadStream(filePath),
    };

    const driveResponse = await drive.files.create({ resource: fileMetadata, media, fields: "id" });
    const fileId = driveResponse.data.id;
    const downloadUrl = `https://drive.google.com/uc?id=${fileId}&export=download`;
    const jobId = `job_${Date.now()}`;

    const jobData = { job_id: jobId, zip_url: downloadUrl, build_mode, webhook_url, email };
    pendingJobs.push(jobData);
    activeJobs.push(jobData);

    console.log("[Server] New Job Added:", jobId, "for", email);
    fs.unlinkSync(filePath);
    res.json({ message: "Job uploaded", job_id: jobId });
  } catch (err) {
    console.error("Upload error:", err.message, err.stack);
    res.status(500).json({ error: err.message || "Failed to upload job" });
  }
});

app.get("/jobs/history", (req, res) => {
  const { email } = req.query;
  if (!email) return res.status(400).json({ message: "Missing email" });
  const jobs = completedJobs.filter((j) => j.email === email);
  res.json({ jobs });
});