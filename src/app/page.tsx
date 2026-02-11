"use client";

import { useMemo, useState, type ChangeEvent } from "react";
import { PDFDocument } from "pdf-lib";
import styles from "./page.module.css";

type PdfJsLib = typeof import("pdfjs-dist");

type ProcessingState = "idle" | "loading" | "rendering" | "saving" | "done" | "error";

type PageResult = {
  index: number;
  jpegBytes: Uint8Array;
  width: number;
  height: number;
};

const MAX_HIGH_QUALITY_MB = 12;
const HIGH_DPI = 300;
const MEDIUM_DPI = 220;
const LOW_DPI = 170;
const MAX_RENDER_PX = 2400;
const MAX_PARALLEL = 6;

const toMegabytes = (bytes: number) => bytes / (1024 * 1024);

const selectDpi = (fileSize: number, pageCount: number) => {
  const sizeMb = toMegabytes(fileSize);
  const isLarge = sizeMb > 18 || pageCount > 50;
  const isMedium = sizeMb > 8 || pageCount > 25;
  if (isLarge) return LOW_DPI;
  if (isMedium) return MEDIUM_DPI;
  return HIGH_DPI;
};

const selectParallelism = (fileSize: number, pageCount: number, dpi: number) => {
  const sizeMb = toMegabytes(fileSize);
  const isLarge = sizeMb > 45 || pageCount > 80;
  const isMedium = sizeMb > 25 || pageCount > 40;
  const isHighDpi = dpi >= HIGH_DPI;

  if (isLarge && isHighDpi) return 1;
  if (isLarge) return 2;
  if (isMedium && isHighDpi) return 2;
  if (isMedium) return 3;
  return 4;
};

const selectJpegQuality = (fileSize: number, pageCount: number, dpi: number) => {
  const sizeMb = toMegabytes(fileSize);
  const isLarge = sizeMb > 18 || pageCount > 50;
  const isMedium = sizeMb > 8 || pageCount > 25;
  const isHighDpi = dpi >= HIGH_DPI;

  if (isLarge && isHighDpi) return 0.5;
  if (isLarge) return 0.52;
  if (isMedium && isHighDpi) return 0.58;
  if (isMedium) return 0.62;
  return 0.68;
};

const clampParallelism = (value: number) =>
  Math.max(1, Math.min(MAX_PARALLEL, value));

const loadPdfJs = async (): Promise<PdfJsLib> => {
  if (typeof window === "undefined") {
    throw new Error("PDF.js doit être chargé côté navigateur.");
  }
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore pdfjs legacy entry has no types.
  const pdfjs = (await import("pdfjs-dist/legacy/build/pdf.mjs")) as PdfJsLib;
  pdfjs.GlobalWorkerOptions.workerSrc = new URL(
    "pdfjs-dist/legacy/build/pdf.worker.mjs",
    import.meta.url
  ).toString();
  return pdfjs;
};

export default function Home() {
  const [file, setFile] = useState<File | null>(null);
  const [processingState, setProcessingState] = useState<ProcessingState>("idle");
  const [progress, setProgress] = useState(0);
  const [status, setStatus] = useState("Glisse un PDF pour démarrer.");
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedDpi, setSelectedDpi] = useState<number | null>(null);

  const fileSizeLabel = useMemo(() => {
    if (!file) return "";
    return `${toMegabytes(file.size).toFixed(1)} Mo`;
  }, [file]);

  const resetOutput = () => {
    if (downloadUrl) {
      URL.revokeObjectURL(downloadUrl);
    }
    setDownloadUrl(null);
    setProgress(0);
    setError(null);
    setSelectedDpi(null);
  };

  const handleFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    const selected = event.target.files?.[0] ?? null;
    setFile(selected);
    setProcessingState("idle");
    setStatus(selected ? "PDF chargé, prêt à inverser." : "Glisse un PDF pour démarrer.");
    resetOutput();
  };

  const processPdf = async () => {
    if (!file) return;
    resetOutput();
    setProcessingState("loading");
    setStatus("Ouverture du PDF...");

    try {
      const buffer = await file.arrayBuffer();
      const pdfjs = await loadPdfJs();
      const loadingTask = pdfjs.getDocument({ data: buffer });
      const sourcePdf = await loadingTask.promise;
      const totalPages = sourcePdf.numPages;
      const dpi = selectDpi(file.size, totalPages);
      setSelectedDpi(dpi);

      const scale = dpi / 72;
      const outputPdf = await PDFDocument.create();
      const jpegQuality = selectJpegQuality(file.size, totalPages, dpi);

      const renderPage = async (pageIndex: number): Promise<PageResult> => {
        const page = await sourcePdf.getPage(pageIndex);
        const baseViewport = page.getViewport({ scale: 1 });
        const maxPageDim = Math.max(baseViewport.width, baseViewport.height);
        const cappedScale = Math.min(scale, MAX_RENDER_PX / maxPageDim);
        const viewport = page.getViewport({ scale: cappedScale });

        const canvas = document.createElement("canvas");
        canvas.width = Math.ceil(viewport.width);
        canvas.height = Math.ceil(viewport.height);

        const context = canvas.getContext("2d", { willReadFrequently: true });
        if (!context) {
          throw new Error("Impossible d'initialiser le canvas.");
        }
        context.imageSmoothingEnabled = true;
        context.imageSmoothingQuality = "high";

        await page.render({ canvasContext: context, viewport, canvas }).promise;

        const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
        const data = imageData.data;
        for (let i = 0; i < data.length; i += 4) {
          data[i] = 255 - data[i];
          data[i + 1] = 255 - data[i + 1];
          data[i + 2] = 255 - data[i + 2];
        }
        context.putImageData(imageData, 0, 0);

        const jpegBlob = await new Promise<Blob>((resolve, reject) => {
          canvas.toBlob((blob) => {
            if (!blob) {
              reject(new Error("Conversion JPEG échouée."));
              return;
            }
            resolve(blob);
          }, "image/jpeg", jpegQuality);
        });

        const jpegBytes = new Uint8Array(await jpegBlob.arrayBuffer());
        canvas.width = 0;
        canvas.height = 0;
        await new Promise((resolve) => requestAnimationFrame(resolve));

        return {
          index: pageIndex,
          jpegBytes,
          width: baseViewport.width,
          height: baseViewport.height,
        };
      };

      const runParallel = async (parallelism: number) => {
        const results: Array<PageResult | undefined> = new Array(totalPages);
        let nextPage = 1;
        let completed = 0;
        let nextWriteIndex = 1;
        let writeLock = Promise.resolve();

        const flushReady = async () => {
          while (results[nextWriteIndex - 1]) {
            const result = results[nextWriteIndex - 1] as PageResult;
            results[nextWriteIndex - 1] = undefined;
            const embedded = await outputPdf.embedJpg(result.jpegBytes);
            const outputPage = outputPdf.addPage([result.width, result.height]);
            outputPage.drawImage(embedded, {
              x: 0,
              y: 0,
              width: result.width,
              height: result.height,
            });
            nextWriteIndex += 1;
          }
        };

        const worker = async () => {
          while (nextPage <= totalPages) {
            const pageIndex = nextPage;
            nextPage += 1;
            setProcessingState("rendering");
            setStatus(`Inversion page ${pageIndex} / ${totalPages}...`);
            const result = await renderPage(pageIndex);
            results[pageIndex - 1] = result;
            completed += 1;
            setProgress(Math.round((completed / totalPages) * 100));
            writeLock = writeLock.then(flushReady).catch(() => undefined);
            await writeLock;
          }
        };

        const workers = Array.from({ length: parallelism }, () => worker());
        await Promise.all(workers);
        await writeLock;
      };

      const baseParallelism = selectParallelism(file.size, totalPages, dpi);
      const parallelism = clampParallelism(baseParallelism);

      try {
        await runParallel(parallelism);
      } catch (parallelError) {
        if (parallelism > 1) {
          await runParallel(1);
        } else {
          throw parallelError;
        }
      }

      setProcessingState("saving");
      setStatus("Finalisation et compression du PDF...");
      const outputBytes = await outputPdf.save({
        useObjectStreams: true,
        addDefaultPage: false,
        objectsPerTick: 50,
      });
      const outputBlob = new Blob([outputBytes as unknown as BlobPart], {
        type: "application/pdf",
      });
      const url = URL.createObjectURL(outputBlob);
      setDownloadUrl(url);
      setStatus("PDF prêt au téléchargement.");
      setProcessingState("done");
    } catch (processError) {
      const message =
        processError instanceof Error
          ? processError.message
          : "Erreur inattendue lors du traitement.";
      setProcessingState("error");
      setError(message);
      setStatus("Échec du traitement.");
    }
  };

  return (
    <div className={styles.page}>
      <div className={styles.backdrop}>
        <div className={styles.orb1}></div>
        <div className={styles.orb2}></div>
        <div className={styles.orb3}></div>
        <div className={styles.orb4}></div>
      </div>

      <main className={styles.main}>
        <header className={styles.hero}>
          <div className={styles.heroBadge}>
            <span className={styles.badgeIcon}>✨</span>
            DarkPDF
          </div>
          <h1 className={styles.heroTitle}>
            Transforme tes PDFs en
            <span className={styles.gradient}> mode sombre</span>
          </h1>
          <p className={styles.heroDescription}>
            Conversion ultra-rapide et locale. Tes documents restent privés avec un rendu professionnel en haute qualité.
          </p>
          <div className={styles.heroStats}>
            <div className={styles.stat}>
              <div className={styles.statIcon}>🔒</div>
              <span>100% Local</span>
            </div>
            <div className={styles.stat}>
              <div className={styles.statIcon}>⚡</div>
              <span>Ultra Rapide</span>
            </div>
            <div className={styles.stat}>
              <div className={styles.statIcon}>🎨</div>
              <span>DPI adaptatif</span>
            </div>
          </div>
        </header>

        <section className={styles.card}>
          <div className={styles.cardGlow}></div>

          <div className={styles.uploadSection}>
            <h2 className={styles.sectionTitle}>Importe ton PDF</h2>

            <label className={styles.dropzone}>
              <div className={styles.dropzoneContent}>
                <div className={styles.uploadIcon}>
                  <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                    <polyline points="17 8 12 3 7 8"/>
                    <line x1="12" y1="3" x2="12" y2="15"/>
                  </svg>
                </div>
                <div className={styles.dropzoneText}>
                  <strong>Glisse ton PDF ici</strong>
                  <span>ou clique pour parcourir</span>
                </div>
              </div>
              <input
                className={styles.fileInput}
                type="file"
                accept="application/pdf"
                onChange={handleFileChange}
              />
            </label>

            {file && (
              <div className={styles.fileInfo}>
                <div className={styles.fileIcon}>📄</div>
                <div className={styles.fileDetails}>
                  <strong>{file.name}</strong>
                  <span>{fileSizeLabel} • {selectedDpi ? `${selectedDpi} DPI` : 'DPI adaptatif'}</span>
                </div>
              </div>
            )}

            <button
              className={styles.convertButton}
              onClick={processPdf}
              disabled={!file || processingState === "rendering" || processingState === "loading" || processingState === "saving"}
            >
              <span className={styles.buttonText}>
                {processingState === "rendering" || processingState === "loading" || processingState === "saving"
                  ? "⚙️ Conversion en cours..."
                  : "🚀 Convertir en mode sombre"}
              </span>
            </button>

            {(processingState === "rendering" || processingState === "loading" || processingState === "saving") && (
              <div className={styles.progress}>
                <div className={styles.progressInfo}>
                  <span className={styles.progressStatus}>{status}</span>
                  <span className={styles.progressPercent}>{progress}%</span>
                </div>
                <div className={styles.progressBar}>
                  <div className={styles.progressFill} style={{ width: `${progress}%` }} />
                </div>
              </div>
            )}

            {error && (
              <div className={styles.errorMessage}>
                <span>⚠️ {error}</span>
              </div>
            )}

            {downloadUrl && (
              <a className={styles.downloadButton} href={downloadUrl} download="pdf-dark-mode.pdf">
                <span>⬇️ Télécharger le PDF transformé</span>
              </a>
            )}
          </div>
        </section>

        <section className={styles.features}>
          <div className={styles.feature}>
            <div className={styles.featureNumber}>01</div>
            <h3>Analyse intelligente</h3>
            <p>Détection automatique de la qualité optimale selon la taille et le nombre de pages.</p>
          </div>
          <div className={styles.feature}>
            <div className={styles.featureNumber}>02</div>
            <h3>Inversion parfaite</h3>
            <p>Chaque pixel est inversé avec précision pour un rendu sombre impeccable.</p>
          </div>
          <div className={styles.feature}>
            <div className={styles.featureNumber}>03</div>
            <h3>Compression optimale</h3>
            <p>Réduction de taille maîtrisée pour garder un rendu net sans exploser le poids.</p>
          </div>
        </section>

        <footer className={styles.footer}>
          <p>Traitement 100% local • Aucune donnée envoyée au serveur</p>
          <p className={styles.copyright}>© 2026 Habib Dan • Tous droits réservés</p>
        </footer>
      </main>
    </div>
  );
}
