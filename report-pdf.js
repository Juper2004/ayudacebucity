(function (root) {
    "use strict";

    const OTHER = "Other / unspecified";
    const REQUEST_STATUSES = ["Under Verification", "Approved", "Pledged", "Fulfilled", "Rejected"];
    const DONATION_STATUSES = ["Pending Approval", "Approved", "Reserved", "Completed", "Rejected", "Expired", "Cancelled"];

    function groupedCounts(records, field, labels) {
        const counts = new Map(labels.map(label => [label, 0]));
        for (const record of records) {
            const label = counts.has(record[field]) ? record[field] : OTHER;
            counts.set(label, (counts.get(label) || 0) + 1);
        }
        return [...counts].map(([label, count]) => ({ label, count }));
    }

    function buildSummary({ requests = [], donations = [], barangays = [], categories = [], generatedAt = new Date() } = {}) {
        const date = new Date(generatedAt);
        const now = date.getTime();
        const pending = request => request.status === "Under Verification";
        const escalated = request => pending(request) && now - Date.parse(request.createdAt) >= 72 * 3600000;
        const fulfilled = requests.filter(request => request.status === "Fulfilled").length;
        const byBarangay = new Map();
        for (const request of requests) {
            const name = barangays.includes(request.barangay) ? request.barangay : OTHER;
            if (!byBarangay.has(name)) byBarangay.set(name, { name, total: 0, pending: 0, fulfilled: 0, escalated: 0 });
            const row = byBarangay.get(name);
            row.total++;
            if (pending(request)) row.pending++;
            if (request.status === "Fulfilled") row.fulfilled++;
            if (escalated(request)) row.escalated++;
        }
        const parts = new Intl.DateTimeFormat("en-US", {
            timeZone: "Asia/Manila", year: "numeric", month: "2-digit", day: "2-digit"
        }).formatToParts(date);
        const part = type => parts.find(item => item.type === type).value;
        return {
            generatedAt: date.toISOString(),
            dateLabel: new Intl.DateTimeFormat("en-PH", {
                timeZone: "Asia/Manila", year: "numeric", month: "long", day: "numeric",
                hour: "2-digit", minute: "2-digit", hour12: true
            }).format(date) + " (Asia/Manila)",
            filename: `ayuda-cebu-dsws-summary-${part("year")}-${part("month")}-${part("day")}.pdf`,
            metrics: {
                totalRequests: requests.length, fulfilled,
                fulfilmentRate: requests.length ? Math.round(fulfilled / requests.length * 100) : 0,
                pending: requests.filter(pending).length,
                escalated: requests.filter(escalated).length,
                activeContributions: donations.filter(donation => donation.status === "Reserved").length,
                totalDonations: donations.length
            },
            requestStatuses: groupedCounts(requests, "status", REQUEST_STATUSES),
            donationStatuses: groupedCounts(donations, "status", DONATION_STATUSES),
            unmetNeeds: groupedCounts(requests.filter(request => !["Fulfilled", "Rejected"].includes(request.status)), "category", categories),
            barangays: [...byBarangay.values()].sort((a, b) => a.name.localeCompare(b.name, "en")),
            invalidPendingDates: requests.filter(request => pending(request) && !Number.isFinite(Date.parse(request.createdAt))).length
        };
    }

    function createPdf(summary, JsPDF) {
        const doc = new JsPDF({ orientation: "portrait", unit: "pt", format: "a4", putOnlyUsedFonts: true });
        if (typeof doc.autoTable !== "function") throw new Error("PDF table library is unavailable.");
        doc.setProperties({ title: "AYUDA CEBU - DSWS Relief Summary", author: "AYUDA CEBU", subject: "Relief request and donation summary" });
        doc.setCreationDate(new Date(summary.generatedAt));
        const width = doc.internal.pageSize.getWidth(), height = doc.internal.pageSize.getHeight();
        const margin = 40, contentWidth = width - margin * 2;
        const blue = [0, 102, 214], ink = [29, 49, 75], muted = [91, 108, 128];
        let y = 40;

        function text(value, x, top, size = 10, bold = false, color = ink) {
            doc.setFont("helvetica", bold ? "bold" : "normal");
            doc.setFontSize(size);
            doc.setTextColor(...color);
            doc.text(Array.isArray(value) ? value : String(value), x, top);
        }
        function room(points) {
            if (y + points > height - 55) {
                doc.addPage();
                y = 66;
            }
        }
        function paragraph(value, size = 9) {
            doc.setFont("helvetica", "normal");
            doc.setFontSize(size);
            const lines = doc.splitTextToSize(value, contentWidth);
            room(lines.length * (size + 4) + 6);
            text(lines, margin, y, size, false, muted);
            y += lines.length * (size + 4) + 6;
        }
        function heading(value) {
            room(75);
            text(value, margin, y, 12, true);
            y += 13;
        }
        function table(head, body, options = {}) {
            doc.autoTable({
                startY: y, head: [head], body, theme: "striped",
                margin: { top: 60, right: margin, bottom: 55, left: margin },
                styles: { font: "helvetica", fontSize: 9, cellPadding: 5, textColor: ink, overflow: "linebreak" },
                headStyles: { fillColor: blue, textColor: [255, 255, 255], fontStyle: "bold" },
                alternateRowStyles: { fillColor: [244, 248, 253] },
                rowPageBreak: "avoid", ...options
            });
            return doc.lastAutoTable.finalY;
        }

        text("AYUDA CEBU", margin, y, 13, true, blue);
        y += 29;
        text("DSWS Relief Summary", margin, y, 24, true);
        y += 19;
        text("Department of Social Welfare and Services | Cebu City", margin, y, 10, false, muted);
        y += 25;
        text("Generated: " + summary.dateLabel, margin, y, 9);
        y += 17;
        paragraph("Scope: All available records as of the generation time. Source: this browser's saved relief records.");
        if (!summary.metrics.totalRequests && !summary.metrics.totalDonations) paragraph("No requests or donations recorded yet.");
        y += 7;

        const metrics = summary.metrics;
        const cards = [
            [metrics.totalRequests, "Total requests"], [metrics.fulfilled, "Fulfilled requests"],
            [metrics.fulfilmentRate + "%", "Fulfilment rate"], [metrics.pending, "Pending verification"],
            [metrics.escalated, "Escalated requests"], [metrics.activeContributions, "Active contributions"]
        ];
        const cardWidth = (contentWidth - 16) / 3;
        cards.forEach(([value, label], index) => {
            const left = margin + (index % 3) * (cardWidth + 8), top = y + Math.floor(index / 3) * 62;
            doc.setFillColor(239, 246, 255);
            doc.roundedRect(left, top, cardWidth, 54, 5, 5, "F");
            text(value, left + 11, top + 25, 21, true, blue);
            text(label, left + 11, top + 43, 9, false, muted);
        });
        y += 143;

        const halfWidth = (contentWidth - 18) / 2;
        text("Request status", margin, y, 12, true);
        text("Donation status", margin + halfWidth + 18, y, 12, true);
        y += 13;
        const leftBottom = table(["Status", "Requests"], summary.requestStatuses.map(row => [row.label, row.count]), {
            tableWidth: halfWidth, columnStyles: { 1: { halign: "right", cellWidth: 60 } }
        });
        const rightBottom = table(["Status", "Donations"], summary.donationStatuses.map(row => [row.label, row.count]), {
            tableWidth: halfWidth, margin: { top: 60, right: margin, bottom: 55, left: margin + halfWidth + 18 },
            columnStyles: { 1: { halign: "right", cellWidth: 64 } }
        });
        y = Math.max(leftBottom, rightBottom) + 23;
        heading("Unmet needs by assistance category");
        y = table(["Category", "Unfulfilled requests"], summary.unmetNeeds.map(row => [row.label, row.count]), {
            columnStyles: { 1: { halign: "right", cellWidth: 140 } }
        }) + 18;
        paragraph("Unmet needs include pending, approved and pledged requests; fulfilled and rejected requests are excluded. Fulfilment rate = fulfilled / all requests, including rejected, rounded to a whole percent.", 8);
        paragraph("Escalated = under verification for at least 72 hours. Active contributions = reserved donations. Donation figures are record counts, not cash totals.", 8);
        if (summary.invalidPendingDates) paragraph(`${summary.invalidPendingDates} pending request(s) have an invalid or missing submission date and cannot be assessed for escalation.`, 8);

        if (summary.barangays.length) {
            doc.addPage();
            y = 70;
            heading("Requests by barangay");
            y += 8;
            paragraph("Barangays with recorded requests, in alphabetical order. Escalated requests are included in pending verification.");
            table(["Barangay", "Total", "Pending", "Fulfilled", "Escalated"], summary.barangays.map(row => [row.name, row.total, row.pending, row.fulfilled, row.escalated]), {
                columnStyles: { 0: { cellWidth: contentWidth - 256 }, 1: { halign: "right", cellWidth: 58 }, 2: { halign: "right", cellWidth: 66 }, 3: { halign: "right", cellWidth: 66 }, 4: { halign: "right", cellWidth: 66 } },
                foot: [["TOTAL", metrics.totalRequests, metrics.pending, metrics.fulfilled, metrics.escalated]],
                showFoot: "lastPage", footStyles: { fillColor: [228, 239, 253], textColor: ink, fontStyle: "bold" }
            });
        } else {
            paragraph("Barangay breakdown: No requests recorded.", 8);
        }

        const pages = doc.getNumberOfPages();
        for (let page = 1; page <= pages; page++) {
            doc.setPage(page);
            if (page > 1) text("AYUDA CEBU  |  DSWS Relief Summary", margin, 34, 10, true, blue);
            doc.setDrawColor(218, 227, 238);
            doc.line(margin, height - 44, width - margin, height - 44);
            text("AYUDA CEBU | All available records", margin, height - 28, 8, false, muted);
            doc.setFontSize(8);
            doc.text(`Page ${page} of ${pages}`, width - margin, height - 28, { align: "right" });
        }
        return doc;
    }

    const api = { buildSummary, createPdf };
    if (typeof module === "object" && module.exports) module.exports = api;
    else root.DswsReport = api;
})(globalThis);
