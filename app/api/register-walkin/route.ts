import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import crypto from "crypto";

const supabaseUrl = process.env.SUPABASE_URL!;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

const supabase = createClient(supabaseUrl, supabaseServiceKey);

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { name, title, company, email, phone, meta, terminalId } = body;

    if (!name) {
      return NextResponse.json({ error: "Name is required" }, { status: 400 });
    }

    if (!terminalId) {
      return NextResponse.json(
        { error: "terminalId is required" },
        { status: 400 }
      );
    }

    // Insert new attendee
    const { data: attendee, error: attendeeError } = await supabase
      .from("attendees")
      .insert({
        name,
        title: title || null,
        company: company || null,
        email: email || null,
        phone: phone || null,
        meta: meta || null,
        status: "active", // Assuming a default status; adjust if needed
      })
      .select()
      .single();

    if (attendeeError || !attendee) {
      console.error("Supabase error inserting attendee:", attendeeError);
      return NextResponse.json(
        { error: "Failed to create attendee", details: attendeeError?.message },
        { status: 500 }
      );
    }

    // Generate unique ticket_code
    const ticketCode = crypto.randomUUID();

    const now = new Date().toISOString();

    // Insert new ticket
    const { error: ticketError } = await supabase.from("tickets").insert({
      attendee_id: attendee.id, // Assuming tickets has attendee_id FK
      ticket_code: ticketCode,
      meta: { ticket_type: "Walk-in" },
      checked_in_at: now,
    });

    if (ticketError) {
      console.error("Supabase error inserting ticket:", ticketError);
      return NextResponse.json(
        { error: "Failed to create ticket", details: ticketError.message },
        { status: 500 }
      );
    }

    // Insert check-in log
    const { error: logError } = await supabase.from("checkin_log").insert({
      ticket_code: ticketCode,
      terminal_id: terminalId,
      success: true,
      message: "Walk-in registration",
      created_at: now,
    });

    if (logError) {
      console.error("Supabase error inserting check-in log:", logError);
      return NextResponse.json(
        { error: "Failed to log check-in", details: logError.message },
        { status: 500 }
      );
    }

    return NextResponse.json({
      ok: true,
      ticket_code: ticketCode,
    });
  } catch (error: any) {
    console.error("API error:", error);
    return NextResponse.json(
      { error: "Internal server error", details: error.message },
      { status: 500 }
    );
  }
}
