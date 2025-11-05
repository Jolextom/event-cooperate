import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.SUPABASE_URL!;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

const supabase = createClient(supabaseUrl, supabaseServiceKey);

export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;
    const terminalId = searchParams.get("terminalId");

    if (!terminalId) {
      return NextResponse.json(
        { error: "terminalId is required" },
        { status: 400 }
      );
    }

    // Step 1: Get all successful check-ins for this terminal
    const { data: checkIns, error: checkInError } = await supabase
      .from("checkin_log")
      .select("id, ticket_code, created_at, message")
      .eq("terminal_id", terminalId)
      .eq("success", true)
      .order("created_at", { ascending: false });

    if (checkInError) {
      console.error("Supabase error fetching check-ins:", checkInError);
      return NextResponse.json(
        { error: "Failed to fetch check-ins", details: checkInError.message },
        { status: 500 }
      );
    }

    if (!checkIns || checkIns.length === 0) {
      return NextResponse.json({
        attendees: [],
        count: 0,
        terminal_id: terminalId,
      });
    }

    // Step 2: Get all ticket codes
    const ticketCodes = checkIns.map((c) => c.ticket_code);

    // Step 3: Fetch tickets with attendee data
    const { data: tickets, error: ticketsError } = await supabase
      .from("tickets")
      .select(
        `
                id,
                ticket_code,
                checked_in_at,
                meta,
                attendees (
                    id,
                    name,
                    email,
                    phone,
                    meta,
                    status,
                    title,
                    company
                )
            `
      )
      .in("ticket_code", ticketCodes);

    if (ticketsError) {
      console.error("Supabase error fetching tickets:", ticketsError);
      return NextResponse.json(
        { error: "Failed to fetch tickets", details: ticketsError.message },
        { status: 500 }
      );
    }

    // Step 4: Create a map of ticket_code to ticket data
    const ticketMap = new Map();
    tickets?.forEach((ticket) => {
      ticketMap.set(ticket.ticket_code, ticket);
    });

    // Step 5: Combine the data
    const attendees = checkIns
      .map((checkIn) => {
        const ticket = ticketMap.get(checkIn.ticket_code);

        if (!ticket || !ticket.attendees) {
          return null; // Skip if no ticket or attendee data
        }

        const attendee = ticket.attendees;

        // Extract ticket type from meta if available
        const ticketType =
          ticket.meta?.ticket_type || ticket.meta?.type || "Standard";

        return {
          id: checkIn.id,
          name: attendee.name || "Unknown",
          email: attendee.email || "N/A",
          phone: attendee.phone || null,
          status: attendee.status || null,
          title: attendee.title || null,
          company: attendee.company || null,
          ticket_code: checkIn.ticket_code,
          checked_in_at: checkIn.created_at,
          ticket_type: ticketType,
          ticket_id: ticket.id,
          attendee_id: attendee.id,
        };
      })
      .filter(Boolean); // Remove null entries

    return NextResponse.json({
      attendees,
      count: attendees.length,
      terminal_id: terminalId,
    });
  } catch (error: any) {
    console.error("API error:", error);
    return NextResponse.json(
      { error: "Internal server error", details: error.message },
      { status: 500 }
    );
  }
}
