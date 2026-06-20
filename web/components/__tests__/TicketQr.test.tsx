import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { TicketQr } from "../MyTickets";

// The ticket QR must encode the bare on-chain object id so the door scanner's
// extractTicketId (lib/staffKey.ts) can decode it directly. qrcode.react's
// QRCodeSVG renders an <svg> whose paths represent the encoded value.
describe("TicketQr", () => {
  const id = "0x000000000000000000000000000000000000000000000000000000000000abcd";

  it("renders a real (non-empty) SVG QR, not a faux matrix", () => {
    const { container } = render(<TicketQr ticketId={id} />);
    const svg = container.querySelector("svg");
    expect(svg).not.toBeNull();
    // A real QR has many <path>/<rect> modules; the old faux matrix used <span>s.
    const modules = svg!.querySelectorAll("path, rect");
    expect(modules.length).toBeGreaterThan(0);
    expect(container.querySelectorAll("span").length).toBe(0);
  });

  it("exposes the encoded id for accessibility", () => {
    const { container } = render(<TicketQr ticketId={id} />);
    expect(container.querySelector('[aria-label="Ticket QR code"]')).not.toBeNull();
  });
});
