function isInWindow(now, start, end) {
  if (!start) return false;
  const s = new Date(start);
  if (Number.isNaN(s.getTime())) return false;
  if (!end) return now >= s;
  const e = new Date(end);
  if (Number.isNaN(e.getTime())) return now >= s;
  return now >= s && now <= e;
}

function isInMaintenance(device, now = new Date()) {
  // store window overrides device window
  const storeActive = isInWindow(now, device.store_maintenance_start, device.store_maintenance_end);
  if (storeActive) return true;
  return isInWindow(now, device.maintenance_start, device.maintenance_end);
}

module.exports = { isInWindow, isInMaintenance };
