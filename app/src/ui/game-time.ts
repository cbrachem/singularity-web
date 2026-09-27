const SECONDS_PER_MINUTE = 60;
const MINUTES_PER_HOUR = 60;
const HOURS_PER_DAY = 24;

/**
 * Text is Presentation, so the Simulation hands over a count of game-seconds and
 * this is where it becomes a readout. The shape follows the reference's own time display
 * (`code/screens/map.py:817`): `DAY %04d, %02d:%02d:%02d`.
 */
export function formatGameTime(gameSeconds: number): string {
  const second = gameSeconds % SECONDS_PER_MINUTE;
  const rawMinutes = Math.floor(gameSeconds / SECONDS_PER_MINUTE);
  const minute = rawMinutes % MINUTES_PER_HOUR;
  const rawHours = Math.floor(rawMinutes / MINUTES_PER_HOUR);
  const hour = rawHours % HOURS_PER_DAY;
  const day = Math.floor(rawHours / HOURS_PER_DAY);

  const pad = (value: number, width: number): string => String(value).padStart(width, "0");
  return `DAY ${pad(day, 4)}, ${pad(hour, 2)}:${pad(minute, 2)}:${pad(second, 2)}`;
}
