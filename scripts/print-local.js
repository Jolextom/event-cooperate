/* local_agent.js
   Usage: set env SUPABASE_URL, SUPABASE_SERVICE_KEY, TERMINAL_ID, PRINTER_NAME
*/
import dotenv from "dotenv";
import fs from "fs";
import os from "os";
import path from "path";
import { createClient } from "@supabase/supabase-js";
import fetch from "node-fetch";
import pkg from "pdf-to-printer";
const { print } = pkg;
dotenv.config({ path: ".env.local" });

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const TERMINAL_ID = process.env.TERMINAL_ID;
const PRINTER_NAME = process.env.PRINTER_NAME;
const POLL_INTERVAL = 3000; // 3s fallback

console.log("keys:", {
  SUPABASE_URL: SUPABASE_URL,
  SUPABASE_KEY: SUPABASE_KEY,
  TERMINAL_ID: TERMINAL_ID,
  PRINTER_NAME: PRINTER_NAME,
});

if (!SUPABASE_URL || !SUPABASE_KEY || !TERMINAL_ID || !PRINTER_NAME) {
  console.error(
    "Missing required env vars: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, TERMINAL_ID, PRINTER_NAME"
  );
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const TEMP_DIR = path.join(os.tmpdir(), "ticket_prints");
if (!fs.existsSync(TEMP_DIR)) {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
}

async function downloadBuffer(storagePath) {
  const { data, error } = await supabase.storage
    .from("tickets")
    .createSignedUrl(storagePath, 60);

  if (error) throw error;

  const res = await fetch(data.signedUrl);
  if (!res.ok) throw new Error("download failed: " + res.statusText);

  return Buffer.from(await res.arrayBuffer());
}

async function updateJob(id, fields) {
  const { error } = await supabase
    .from("print_jobs")
    .update({ ...fields, updated_at: new Date().toISOString() })
    .eq("id", id);

  if (error) console.error("Failed to update job", id, error);
}

async function processJob(job) {
  console.log(`Processing print job ${job.id} for ticket ${job.ticket_id}`);

  try {
    // Validate file_path exists
    if (!job.file_path) {
      throw new Error("No file_path in print job");
    }

    // Mark as printing
    await updateJob(job.id, {
      status: "printing",
      attempt_count: (job.attempt_count ?? 0) + 1,
    });

    console.log(`PDF path: ${job.file_path}`);

    // Download PDF from Supabase storage
    const buf = await downloadBuffer(job.file_path);
    const tmpFile = path.join(TEMP_DIR, `${job.id}.pdf`);
    fs.writeFileSync(tmpFile, buf);

    // Print
    console.log(`Printing ${tmpFile} to ${PRINTER_NAME}`);
    await print(tmpFile, {
      printer: PRINTER_NAME,
      win32: ["-silent"],
    });

    // Mark as printed
    await updateJob(job.id, { status: "printed" });
    console.log(`✓ Printed job ${job.id}`);

    // Clean up temp file
    try {
      fs.unlinkSync(tmpFile);
    } catch (e) {
      console.warn("Failed to delete temp file:", e.message);
    }
  } catch (err) {
    console.error(`✗ Print failed for job ${job.id}:`, err);
    await updateJob(job.id, {
      status: "failed",
      last_error: String(err).slice(0, 1000),
      attempt_count: (job.attempt_count ?? 0) + 1,
    });
  }
}

function shouldProcessJob(job) {
  // Process if: status is ready_to_print AND assigned to our terminal
  if (job.status !== "ready_to_print") return false;
  if (job.terminal_id === TERMINAL_ID) return true;
  return false;
}

async function handleJobChange(payload) {
  const job = payload.new;

  if (!shouldProcessJob(job)) {
    return; // Not for us
  }

  console.log("Received job:", job.id);
  await processJob(job);
}

async function startRealtime() {
  console.log(`Starting realtime listener for terminal ${TERMINAL_ID}`);

  const channel = supabase
    .channel("print-jobs-channel")
    .on(
      "postgres_changes",
      {
        event: "UPDATE",
        schema: "public",
        table: "print_jobs",
        filter: `terminal_id=eq.${TERMINAL_ID}`,
      },
      (payload) => {
        handleJobChange(payload);
      }
    )
    .subscribe((status, err) => {
      if (status === "SUBSCRIBED") {
        console.log("✓ Realtime connected — listening for print jobs");
      }
      if (status === "CHANNEL_ERROR") {
        console.error("Realtime channel error:", err);
        console.log("Falling back to polling...");
        startPolling();
      }
    });

  return channel;
}

let polling = false;

async function startPolling() {
  if (polling) return;
  polling = true;

  console.log(`Starting polling fallback (every ${POLL_INTERVAL}ms)`);

  while (polling) {
    try {
      const { data: jobs, error } = await supabase
        .from("print_jobs")
        .select("*")
        .eq("status", "ready_to_print")
        .eq("terminal_id", TERMINAL_ID)
        .order("created_at", { ascending: true })
        .limit(5);

      if (error) throw error;

      for (const job of jobs || []) {
        await processJob(job);
      }
    } catch (err) {
      console.error("Polling error:", err);
    }

    await new Promise((r) => setTimeout(r, POLL_INTERVAL));
  }
}

async function main() {
  console.log("=".repeat(50));
  console.log("Ticket Print Agent Started");
  console.log("Terminal ID:", TERMINAL_ID);
  console.log("Printer:", PRINTER_NAME);
  console.log("=".repeat(50));

  // Process any existing ready_to_print jobs on startup
  try {
    const { data: readyJobs } = await supabase
      .from("print_jobs")
      .select("*")
      .eq("status", "ready_to_print")
      .eq("terminal_id", TERMINAL_ID)
      .order("created_at", { ascending: true });

    if (readyJobs && readyJobs.length > 0) {
      console.log(`Found ${readyJobs.length} ready job(s) on startup`);
      for (const job of readyJobs) {
        await processJob(job);
      }
    }
  } catch (err) {
    console.error("Error processing startup jobs:", err);
  }

  // Start realtime listener
  try {
    await startRealtime();
  } catch (err) {
    console.error("Realtime start failed:", err);
    startPolling();
  }
}

main().catch(console.error);
