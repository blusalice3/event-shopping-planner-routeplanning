import { ShoppingItem } from '../types';

export function extractEventDates(items: ShoppingItem[]): string[] {
  const eventDates = new Set<string>();
  items.forEach((item) => {
    if (item.eventDate && item.eventDate.trim()) {
      eventDates.add(item.eventDate.trim());
    }
  });

  return Array.from(eventDates).sort((a, b) => {
    const numA = parseInt(a.match(/\d+/)?.[0] || '0', 10);
    const numB = parseInt(b.match(/\d+/)?.[0] || '0', 10);
    if (numA !== numB) return numA - numB;
    return a.localeCompare(b, 'ja');
  });
}
