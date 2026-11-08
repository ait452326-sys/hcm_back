function workingDays(start, end, weekend = [0, 6], holidays = []) {
    if (!start || !end) return 0;

    const parseDate = (value) => {
        const [year, month, day] = String(value).slice(0, 10).split('-').map(Number);
        return new Date(year, month - 1, day, 12);
    };

    const d = parseDate(start);
    const last = parseDate(end);

    if (isNaN(d.getTime()) || isNaN(last.getTime()) || d > last) {
        return 0;
    }

    let count = 0;
    const holidaySet = new Set(
        holidays.map(date => String(date).slice(0, 10))
    );

    while (d <= last) {
        const day = d.getDay();

        const key = [
            d.getFullYear(),
            String(d.getMonth() + 1).padStart(2, '0'),
            String(d.getDate()).padStart(2, '0')
        ].join('-');

        if (!weekend.includes(day) && !holidaySet.has(key)) {
            count++;
        }

        d.setDate(d.getDate() + 1);
    }

    return count;
}

function haversine(lat1, lon1, lat2, lon2) {
    const radius = 6371000;
    const rad = value => value * Math.PI / 180;

    const dLat = rad(lat2 - lat1);
    const dLon = rad(lon2 - lon1);

    const a =
        Math.sin(dLat / 2) ** 2 +
        Math.cos(rad(lat1)) *
        Math.cos(rad(lat2)) *
        Math.sin(dLon / 2) ** 2;

    return 2 * radius * Math.atan2(
        Math.sqrt(a),
        Math.sqrt(1 - a)
    );
}

module.exports = {
    workingDays,
    haversine
};
