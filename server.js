import dotenv from "dotenv";
dotenv.config();

import express from "express";
import cors from "cors";
import multer from "multer";
import fs from "fs";
import path from "path";
import { google } from "googleapis";
import authRoutes from "./routes/auth.js";

const app = express();
const PORT = process.env.PORT || 3000;

/* =======================
   Middleware
======================= */
app.use(cors({
  origin: "*",
  methods: ["GET", "POST"],
}));
app.use(express.json());

app.use("/api/auth", authRoutes);

/* =======================
   Ensure folders exist
======================= */
["uploads"].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir);
});

/* =======================
   Google Drive
======================= */
let drive;
const KEYFILEPATH = "/etc/secrets/gdrive-key.json";
const DRIVE_FOLDER_ID = "1olOvZZbvGuyzoB-9L1d8sZXe9iEzauOA";

try {
  const auth = new google.auth.GoogleAuth({
    keyFile: KEYFILEPATH,
    scopes: ["https://www.googleapis.com/auth/drive"],
  });
  drive = google.drive({ version: "v3", auth });
  console.log("✅ Google Drive initialized");
} catch (e) {
  console.error("❌ Google Drive init failed:", e.message);
}

/* =======================
   Multer
======================= */
const upload = multer({
  storage: multer.diskStorage({
    destination: "uploads/",
    filename: (_, file, cb) => cb(null, `${Date.now()}-${file.originalname}`)
  }),
  limits: { fileSize: 100 * 1024 * 1024 }
});

/* =======================
   Job Queues
======================= */
let pendingJobs = [];
let activeJobs = [];
let completedJobs = [];

/* =======================
   ROUTES
======================= */

// ✅ Agent polls this
app.get("/jobs/next", (req, res) => {
  if (!pendingJobs.length) {
    return res.json({ job_id: null });
  }
  const job = pendingJobs.shift();
  console.log("➡️ Job dispatched:", job.job_id);
  res.json(job);
});

// ✅ Agent reports here
app.post("/jobs/result", (req, res) => {
  const { job_id, status, output_url, error } = req.body;
  const job = activeJobs.find(j => j.job_id === job_id);

  completedJobs.push({
    job_id,
    status,
    output_url,
    error,
    email: job?.email,
    timestamp: new Date()
  });

  activeJobs = activeJobs.filter(j => j.job_id !== job_id);
  res.json({ ok: true });
});

// ✅ Frontend upload
app.post("/jobs/upload", upload.single("job"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No ZIP uploaded" });
    }

    const { build_mode = "simulator", email } = req.body;

    const fileStream = fs.createReadStream(req.file.path);

    const driveFile = await drive.files.create({
      resource: {
        name: req.file.originalname,
        parents: [DRIVE_FOLDER_ID],
      },
      media: {
        mimeType: "application/zip",
        body: fileStream,
      },
      fields: "id",
    });

    await drive.permissions.create({
      fileId: driveFile.data.id,
      requestBody: { role: "reader", type: "anyone" },
    });

    const zipUrl = `https://drive.google.com/uc?id=${driveFile.data.id}&export=download`;
    const jobId = `job_${Date.now()}`;

    const job = {
      job_id: jobId,
      zip_url: zipUrl,
      build_mode,
      email,
    };

    pendingJobs.push(job);
    activeJobs.push(job);

    fs.unlinkSync(req.file.path);

    console.log("✅ Job queued:", jobId);
    res.json({ job_id: jobId });

  } catch (e) {
    console.error("❌ Upload failed:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// ✅ History
app.get("/jobs/history", (req, res) => {
  const { email } = req.query;
  res.json({
    jobs: completedJobs.filter(j => j.email === email)
  });
});

app.listen(PORT, () => {
  console.log(`🚀 MacBridge API running on ${PORT}`);
});