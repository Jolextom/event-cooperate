import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.SUPABASE_URL!;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

const supabase = createClient(supabaseUrl, supabaseServiceKey);

const DEFAULT_EVENT_ID = "6a9cb25b-af48-4ad3-84ca-0d050c848dee";

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const query = searchParams.get("query");
    const terminalId = searchParams.get("terminalId");

    if (!query) {
      return NextResponse.json({ error: "Query is required" }, { status: 400 });
    }

    if (!terminalId) {
      return NextResponse.json(
        { error: "terminalId is required" },
        { status: 400 }
      );
    }

    const searchTerm = `%${query.toLowerCase()}%`;

    // First, search attendees
    const { data: attendees, error: attendeeError } = await supabase
      .from("attendees")
      .select("*")
      .eq("event_id", DEFAULT_EVENT_ID)
      .or(
        `name.ilike.${searchTerm},email.ilike.${searchTerm},phone.ilike.${searchTerm}`
      )
      .limit(20);

    if (attendeeError) {
      console.error("Supabase search error:", attendeeError);
      return NextResponse.json(
        { error: "Search failed", details: attendeeError.message },
        { status: 500 }
      );
    }

    if (!attendees || attendees.length === 0) {
      return NextResponse.json({ results: [] });
    }

    // Get attendee IDs
    const attendeeIds = attendees.map((a) => a.id);

    // Fetch tickets for these attendees
    const { data: tickets, error: ticketError } = await supabase
      .from("tickets")
      .select("*")
      .in("attendee_id", attendeeIds);

    if (ticketError) {
      console.error("Supabase ticket fetch error:", ticketError);
    }

    // Map tickets by attendee_id for quick lookup
    const ticketMap = new Map();
    (tickets || []).forEach((ticket: any) => {
      ticketMap.set(ticket.attendee_id, ticket);
    });

    // Combine results and FILTER out attendees without tickets
    const results = attendees
      .map((attendee: any) => {
        const ticket = ticketMap.get(attendee.id);

        // Skip attendees without tickets
        if (!ticket || !ticket.ticket_code) {
          return null;
        }

        return {
          id: attendee.id,
          name: attendee.name,
          email: attendee.email,
          phone: attendee.phone,
          status: attendee.status,
          title: attendee.title,
          company: attendee.company,
          ticket_code: ticket.ticket_code, // ← Guaranteed to exist now
          ticket_type: ticket.meta?.ticket_type || null,
          meta: attendee.meta,
          checked_in: !!ticket.checked_in_at,
        };
      })
      .filter(Boolean); // Remove null entries

    return NextResponse.json({ results });
  } catch (error: any) {
    console.error("API error:", error);
    return NextResponse.json(
      { error: "Internal server error", details: error.message },
      { status: 500 }
    );
  }
}
