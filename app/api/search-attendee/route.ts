import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.SUPABASE_URL!;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

const supabase = createClient(supabaseUrl, supabaseServiceKey);

export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;
    const query = searchParams.get("query");
    const terminalId = searchParams.get("terminalId");

    if (!query) {
      return NextResponse.json({ error: "query is required" }, { status: 400 });
    }

    if (!terminalId) {
      return NextResponse.json(
        { error: "terminalId is required" },
        { status: 400 }
      );
    }

    // Search tickets with related attendees, filtering on attendee fields
    const { data: tickets, error: searchError } = await supabase
      .from("tickets")
      .select(
        `
          id,
          ticket_code,
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
      .or(
        `attendees.name.ilike.%${query}%,attendees.email.ilike.%${query}%,attendees.phone.ilike.%${query}%`
      );

    if (searchError) {
      console.error("Supabase error searching attendees:", searchError);
      return NextResponse.json(
        { error: "Failed to search attendees", details: searchError.message },
        { status: 500 }
      );
    }

    if (!tickets || tickets.length === 0) {
      return NextResponse.json({
        results: [],
      });
    }

    // Extract ticket codes
    const ticketCodes = tickets.map((t) => t.ticket_code);

    // Get successful check-ins for this terminal and these codes
    const { data: checkIns, error: checkInError } = await supabase
      .from("checkin_log")
      .select("ticket_code")
      .eq("terminal_id", terminalId)
      .eq("success", true)
      .in("ticket_code", ticketCodes);

    if (checkInError) {
      console.error("Supabase error fetching check-ins:", checkInError);
      return NextResponse.json(
        { error: "Failed to fetch check-ins", details: checkInError.message },
        { status: 500 }
      );
    }

    const checkedSet = new Set(checkIns?.map((c) => c.ticket_code) || []);

    // Map to SearchResult
    const results = tickets.map((ticket) => {
      const attendee = ticket.attendees;
      return {
        id: attendee.id,
        name: attendee.name || "Unknown",
        email: attendee.email || undefined,
        phone: attendee.phone || undefined,
        status: attendee.status || undefined,
        title: attendee.title || undefined,
        company: attendee.company || undefined,
        ticket_code: ticket.ticket_code,
        ticket_type: ticket.meta?.ticket_type || ticket.meta?.type || undefined,
        meta: attendee.meta || undefined,
        checked_in: checkedSet.has(ticket.ticket_code),
      };
    });

    return NextResponse.json({
      results,
    });
  } catch (error: any) {
    console.error("API error:", error);
    return NextResponse.json(
      { error: "Internal server error", details: error.message },
      { status: 500 }
    );
  }
}
