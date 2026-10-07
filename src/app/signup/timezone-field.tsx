"use client";

import { useEffect, useState } from "react";

export function TimezoneField() {
  const [tz, setTz] = useState("UTC");
  useEffect(() => setTz(Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"), []);
  return (
    <div>
      <label className="label" htmlFor="timezone">Time zone</label>
      <input className="input" id="timezone" name="timezone" value={tz} onChange={(e) => setTz(e.target.value)} />
    </div>
  );
}
