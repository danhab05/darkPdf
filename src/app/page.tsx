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

const MAX_HIGH_QUALITY_MB = 30;
const HIGH_DPI = 900;
const MEDIUM_DPI = 600;
const MAX_PARALLEL = 6;

const toMegabytes = (bytes: number) => bytes / (1024 * 1024);

const selectDpi = (fileSize: number, pageCount: number) => {
  if (fileSize > MAX_HIGH_QUALITY_MB * 1024 * 1024 || pageCount > 60) {
    return MEDIUM_DPI;
  }
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
  const isLarge = sizeMb > 45 || pageCount > 80;
  const isMedium = sizeMb > 25 || pageCount > 40;
  const isHighDpi = dpi >= HIGH_DPI;

  if (isLarge && isHighDpi) return 0.6;
  if (isLarge) return 0.65;
  if (isMedium && isHighDpi) return 0.7;
  if (isMedium) return 0.75;
  return 0.82;
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
        const viewport = page.getViewport({ scale });
        const baseViewport = page.getViewport({ scale: 1 });

        const canvas = document.createElement("canvas");
        canvas.width = Math.ceil(viewport.width);
        canvas.height = Math.ceil(viewport.height);

        const context = canvas.getContext("2d", { willReadFrequently: true });
        if (!context) {
          throw new Error("Impossible d'initialiser le canvas.");
        }

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
      setStatus("Finalisation du PDF inversé...");
      const outputBytes = await outputPdf.save();
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
      <div className={styles.backdrop} />
      <main className={styles.main}>
        <header className={styles.hero}>
          <div className={styles.heroBadge}>Liquid Glass PDF</div>
          <h1>Transforme tes PDF en mode nuit premium.</h1>
          <p>
            DarkPdf recrée un PDF sombre ultra net. Le traitement se fait dans ton
            navigateur, sans upload serveur.
          </p>
          <div className={styles.heroHighlights}>
            <div className={styles.highlight}>Local & privé</div>
            <div className={styles.highlight}>Qualité 600-900 dpi</div>
            <div className={styles.highlight}>Multi‑pages support</div>
          </div>
        </header>

        <section className={styles.glassPanel}>
          <div className={styles.panelHeader}>
            <div>
              <h2>Dépose ton PDF</h2>
              <p>On inverse chaque pixel pour un vrai dark mode.</p>
            </div>
            <div className={styles.panelMeta}>
              <span>Qualité adaptative</span>
              <span>600 / 900 dpi · JPEG adaptatif</span>
            </div>
          </div>

          <div className={styles.uploadRow}>
            <label className={styles.fileLabel}>
              <span className={styles.fileTitle}>Glisser ou cliquer</span>
              <span className={styles.fileHint}>PDF uniquement, traitement local.</span>
              <input
                className={styles.fileInput}
                type="file"
                accept="application/pdf"
                onChange={handleFileChange}
              />
            </label>
            <div className={styles.fileSummary}>
              <div>
                <span>Fichier</span>
                <strong>{file ? file.name : "Aucun PDF sélectionné"}</strong>
              </div>
              <div>
                <span>Taille</span>
                <strong>{file ? fileSizeLabel : "--"}</strong>
              </div>
              <div>
                <span>DPI</span>
                <strong>{selectedDpi ? `${selectedDpi} dpi` : "Adaptatif"}</strong>
              </div>
            </div>
          </div>

          <button
            className={styles.primaryButton}
            onClick={processPdf}
            disabled={!file || processingState === "rendering" || processingState === "loading" || processingState === "saving"}
          >
            {processingState === "rendering" ||
            processingState === "loading" ||
            processingState === "saving"
              ? "Traitement en cours..."
              : "Créer le PDF sombre"}
          </button>

          <div className={styles.progressWrapper}>
            <div className={styles.progressHeader}>
              <span>{status}</span>
              <span>{progress}%</span>
            </div>
            <div className={styles.progressBar}>
              <div
                className={styles.progressFill}
                style={{ width: `${progress}%` }}
              />
            </div>
          </div>

          {error && <p className={styles.error}>{error}</p>}

          {downloadUrl && (
            <a className={styles.download} href={downloadUrl} download="pdf-dark-mode.pdf">
              Télécharger le PDF inversé
            </a>
          )}
        </section>

        <section className={styles.steps}>
          <div className={styles.stepCard}>
            <span>01</span>
            <h3>Analyse locale</h3>
            <p>Chargement sécurisé et qualité adaptative selon taille/pages.</p>
          </div>
          <div className={styles.stepCard}>
            <span>02</span>
            <h3>Inversion pixel</h3>
            <p>Chaque page est rendue puis inversée pour un vrai dark mode.</p>
          </div>
          <div className={styles.stepCard}>
            <span>03</span>
            <h3>PDF final</h3>
            <p>On reconstruit un nouveau PDF sombre prêt à télécharger.</p>
          </div>
        </section>

        <footer className={styles.footer}>
          <p>
            Traitement 100% local. Compression JPEG adaptative pour réduire
            fortement la taille finale.
          </p>
        </footer>
      </main>
    </div>
  );
}
