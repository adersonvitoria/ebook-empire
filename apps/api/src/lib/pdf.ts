// Geracao de PDF do ebook a partir de capitulos.
// Usa pdfkit (dep ja declarada no package.json da API). A funcao retorna um
// Buffer pronto para ser persistido via StoragePort.putObject(key, bytes).
//
// O conteudo de entrada e independente do Prisma: aceita um shape simples
// (titulo + capitulos) para ser facilmente testavel e reutilizavel pelo agente.

import PDFDocument from 'pdfkit';

// ------------------------------------------------------------
// Shape de entrada do PDF (desacoplado do modelo Prisma).
// ------------------------------------------------------------
export interface EbookPdfChapter {
  title: string;
  /** Corpo do capitulo em texto/markdown simples (paragrafos por \n\n). */
  body: string;
}

export interface EbookPdfInput {
  title: string;
  subtitle?: string;
  author?: string;
  niche?: string;
  chapters: EbookPdfChapter[];
}

// ------------------------------------------------------------
// buildEbookPdf — monta o PDF e resolve com o Buffer completo.
// ------------------------------------------------------------
export function buildEbookPdf(input: EbookPdfInput): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({
        size: 'A4',
        margins: { top: 64, bottom: 64, left: 64, right: 64 },
        info: {
          Title: input.title,
          Author: input.author ?? 'Ebook Empire',
          Subject: input.niche ?? 'Ebook',
        },
      });

      const chunks: Buffer[] = [];
      doc.on('data', (chunk: Buffer) => chunks.push(chunk));
      doc.on('error', reject);
      doc.on('end', () => resolve(Buffer.concat(chunks)));

      renderCover(doc, input);
      renderTableOfContents(doc, input);
      renderChapters(doc, input);

      doc.end();
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

// ------------------------------------------------------------
// Capa
// ------------------------------------------------------------
function renderCover(doc: PDFKit.PDFDocument, input: EbookPdfInput): void {
  doc.moveDown(6);
  doc.fontSize(30).font('Helvetica-Bold').text(input.title, { align: 'center' });

  if (input.subtitle) {
    doc.moveDown(1);
    doc.fontSize(16).font('Helvetica').text(input.subtitle, { align: 'center' });
  }

  doc.moveDown(4);
  doc
    .fontSize(12)
    .font('Helvetica-Oblique')
    .text(input.author ?? 'Ebook Empire', { align: 'center' });

  if (input.niche) {
    doc.moveDown(0.5);
    doc.fontSize(10).font('Helvetica').text(`Nicho: ${input.niche}`, { align: 'center' });
  }
}

// ------------------------------------------------------------
// Sumario
// ------------------------------------------------------------
function renderTableOfContents(doc: PDFKit.PDFDocument, input: EbookPdfInput): void {
  doc.addPage();
  doc.fontSize(20).font('Helvetica-Bold').text('Sumario');
  doc.moveDown(1);
  doc.fontSize(12).font('Helvetica');
  input.chapters.forEach((chapter, i) => {
    doc.text(`${i + 1}. ${chapter.title}`);
    doc.moveDown(0.3);
  });
}

// ------------------------------------------------------------
// Capitulos
// ------------------------------------------------------------
function renderChapters(doc: PDFKit.PDFDocument, input: EbookPdfInput): void {
  input.chapters.forEach((chapter, i) => {
    doc.addPage();
    doc
      .fontSize(18)
      .font('Helvetica-Bold')
      .text(`Capitulo ${i + 1}: ${chapter.title}`);
    doc.moveDown(1);

    doc.fontSize(12).font('Helvetica');
    const paragraphs = chapter.body.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
    if (paragraphs.length === 0) {
      doc.text('(sem conteudo)');
    }
    paragraphs.forEach((p) => {
      doc.text(p, { align: 'justify' });
      doc.moveDown(0.6);
    });
  });
}
