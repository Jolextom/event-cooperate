import dotenv from "dotenv";
import fs from "fs";
import os from "os";
import path from "path";
import pkg from "pdf-to-printer";
import { PDFDocument, rgb, StandardFonts } from "pdf-lib";

const { print } = pkg;
dotenv.config({ path: ".env.local" });

const PRINTER_NAME = process.env.PRINTER_NAME;
if (!PRINTER_NAME) {
  console.error("Missing PRINTER_NAME in .env.local");
  process.exit(1);
}

function mmToPoints(mm) {
  return Math.round(mm * 2.83465);
}

// Edit these to your label size (in mm)
const PAGE_WIDTH_MM = 80; // full thermal width
const PAGE_HEIGHT_MM = 50;
const PAGE_WIDTH_PT = mmToPoints(PAGE_WIDTH_MM);
const PAGE_HEIGHT_PT = mmToPoints(PAGE_HEIGHT_MM);

const TEMP_DIR = path.join(os.tmpdir(), "test_prints");
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

async function generatePDF(name, pageWidth, pageHeight) {
  const pdfDoc = await PDFDocument.create();
  const page = pdfDoc.addPage([pageWidth, pageHeight]);

  // Center text
  const font = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const fontSize = 24;
  const textWidth = font.widthOfTextAtSize(name, fontSize);
  page.drawText(name, {
    x: (pageWidth - textWidth) / 2,
    y: (pageHeight - fontSize) / 2,
    size: fontSize,
    font,
    color: rgb(0, 0, 0),
  });

  // Draw border around the entire page (2mm from edges)
  const borderMargin = mmToPoints(2);
  page.drawRectangle({
    x: borderMargin,
    y: borderMargin,
    width: pageWidth - borderMargin * 2,
    height: pageHeight - borderMargin * 2,
    borderColor: rgb(0, 0, 0),
    borderWidth: 1.5,
  });

  // Add size label
  const smallFont = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const smallFontSize = 8;
  const sizeText = `${PAGE_WIDTH_MM}x${PAGE_HEIGHT_MM}mm`;
  const sizeTextWidth = smallFont.widthOfTextAtSize(sizeText, smallFontSize);
  page.drawText(sizeText, {
    x: (pageWidth - sizeTextWidth) / 2,
    y: mmToPoints(3),
    size: smallFontSize,
    font: smallFont,
    color: rgb(0.5, 0.5, 0.5),
  });

  const pdfBytes = await pdfDoc.save();
  return Buffer.from(pdfBytes);
}

async function run() {
  const name = "HELLO";
  const pdfBuffer = await generatePDF(name, PAGE_WIDTH_PT, PAGE_HEIGHT_PT);
  const tmpFile = path.join(TEMP_DIR, `test-${Date.now()}.pdf`);
  fs.writeFileSync(tmpFile, pdfBuffer);

  console.log(`PDF saved to: ${tmpFile}`);
  console.log(`Printing to: ${PRINTER_NAME}`);
  try {
    await print(tmpFile, {
      printer: PRINTER_NAME,
      win32: ["-silent"],
      orientation: "landscape",
    });
    console.log("Print job sent!");
  } catch (err) {
    console.error("Print failed:", err);
  }
}

run().catch(console.error);
