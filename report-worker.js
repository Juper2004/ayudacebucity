"use strict";

// Receive aggregate totals only; keep PDF layout work off the phone's UI thread.
self.onmessage = function (event) {
    try {
        importScripts(
            "/vendor/jspdf.umd.min.js",
            "/vendor/jspdf.plugin.autotable.min.js",
            "/report-pdf.js"
        );
        // AutoTable only auto-registers on window; a dedicated worker has self.
        self.applyPlugin(self.jspdf.jsPDF);
    } catch {
        self.postMessage({ error: "PDF files could not be loaded from the app server. Restart the app server, then refresh this page and try again." });
        return;
    }

    try {
        const doc = self.DswsReport.createPdf(event.data, self.jspdf.jsPDF);
        const buffer = doc.output("arraybuffer");
        if (!(buffer instanceof ArrayBuffer) || !buffer.byteLength) throw new Error("Empty PDF");
        self.postMessage({ buffer }, [buffer]);
    } catch {
        self.postMessage({ error: "The PDF could not be created. Please refresh the page and try again." });
    }
};
