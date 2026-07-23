(function initialiseHomepageExperience() {
    "use strict";

    function nextLocalOccurrence(time, now = new Date()) {
        const [hours, minutes] = time.split(":").map(Number);
        const occurrence = new Date(now);

        occurrence.setHours(hours, minutes, 0, 0);

        if (occurrence <= now) {
            occurrence.setDate(occurrence.getDate() + 1);
        }

        return occurrence;
    }

    function toCalendarTimestamp(date) {
        return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
    }

    function escapeCalendarText(value) {
        return String(value)
            .replace(/\\/g, "\\\\")
            .replace(/\r?\n/g, "\\n")
            .replace(/,/g, "\\,")
            .replace(/;/g, "\\;");
    }

    function createCalendarFile({ title, time, duration }) {
        const start = nextLocalOccurrence(time);
        const end = new Date(start.getTime() + duration * 60 * 1000);
        const eventId = `welfare-feed-${start.getTime()}@alpacalyeverafter.co.uk`;
        const calendar = [
            "BEGIN:VCALENDAR",
            "VERSION:2.0",
            "PRODID:-//Alpacaly Ever After//Alpacaly Live//EN",
            "CALSCALE:GREGORIAN",
            "METHOD:PUBLISH",
            "BEGIN:VEVENT",
            `UID:${eventId}`,
            `DTSTAMP:${toCalendarTimestamp(new Date())}`,
            `DTSTART:${toCalendarTimestamp(start)}`,
            `DTEND:${toCalendarTimestamp(end)}`,
            `SUMMARY:${escapeCalendarText(title)}`,
            `DESCRIPTION:${escapeCalendarText("Tune in to Alpacaly Live. Feeding takes place only when approved by the care team and may be delayed or cancelled for welfare reasons.")}`,
            `LOCATION:${escapeCalendarText("Alpacaly Live online")}`,
            "BEGIN:VALARM",
            "TRIGGER:-PT10M",
            "ACTION:DISPLAY",
            `DESCRIPTION:${escapeCalendarText("Alpacaly Live starts in 10 minutes")}`,
            "END:VALARM",
            "END:VEVENT",
            "END:VCALENDAR",
            ""
        ].join("\r\n");

        return { calendar, start };
    }

    if (typeof module !== "undefined" && module.exports) {
        module.exports = {
            createCalendarFile,
            escapeCalendarText,
            nextLocalOccurrence,
            toCalendarTimestamp
        };
    }

    if (typeof document === "undefined") {
        return;
    }

    const reminderButtons = document.querySelectorAll("[data-reminder-time]");
    const reminderStatus = document.getElementById("programme-reminder-status");

    if (reminderButtons.length === 0) {
        return;
    }

    function downloadReminder(button) {
        const title = button.dataset.reminderTitle || "Alpacaly Live programme";
        const time = button.dataset.reminderTime;
        const duration = Number(button.dataset.reminderDuration) || 30;
        const { calendar, start } = createCalendarFile({ title, time, duration });
        const blob = new Blob([calendar], { type: "text/calendar;charset=utf-8" });
        const url = URL.createObjectURL(blob);
        const download = document.createElement("a");
        const date = start.toISOString().slice(0, 10);

        download.href = url;
        download.download = `alpacaly-live-${date}.ics`;
        download.hidden = true;
        document.body.appendChild(download);
        download.click();
        download.remove();
        window.setTimeout(() => URL.revokeObjectURL(url), 1000);

        const displayTime = new Intl.DateTimeFormat(undefined, {
            weekday: "short",
            hour: "2-digit",
            minute: "2-digit"
        }).format(start);

        button.textContent = "Reminder ready";

        if (reminderStatus) {
            reminderStatus.textContent = `Calendar reminder downloaded for ${displayTime}.`;
        }
    }

    reminderButtons.forEach((button) => {
        button.addEventListener("click", () => downloadReminder(button));
    });
}());
