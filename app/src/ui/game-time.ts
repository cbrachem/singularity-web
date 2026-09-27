const SECONDS_PER_MINUTE = 60;
const MINUTES_PER_HOUR = 60;
const HOURS_PER_DAY = 24;

/**
 * Text is Presentation, so the Simulation hands over a count of game-seconds and
 * this is where it becomes a readout. The reference writes `DAY %04d, %02d:%02d:%02d`
 * (`code/screens/map.py:817`); the port drops the day's zero padding, which only made the
 * number harder to read.
 */
export function gameClock(gameSeconds: number): { readonly day: number; readonly time: string } {
  const second = gameSeconds % SECONDS_PER_MINUTE;
  const rawMinutes = Math.floor(gameSeconds / SECONDS_PER_MINUTE);
  const minute = rawMinutes % MINUTES_PER_HOUR;
  const rawHours = Math.floor(rawMinutes / MINUTES_PER_HOUR);
  const hour = rawHours % HOURS_PER_DAY;
  const day = Math.floor(rawHours / HOURS_PER_DAY);

  const pad = (value: number): string => String(value).padStart(2, "0");
  return { day, time: `${pad(hour)}:${pad(minute)}:${pad(second)}` };
}

export function formatGameTime(gameSeconds: number): string {
  const { day, time } = gameClock(gameSeconds);
  return `Day ${day} · ${time}`;
}
