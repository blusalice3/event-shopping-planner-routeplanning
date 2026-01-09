import { ShoppingItem } from '../types';

export function getItemKey(item: ShoppingItem | Omit<ShoppingItem, 'id' | 'purchaseStatus'>): string {
  return `${item.circle}|${item.eventDate}|${item.block}|${item.number}|${item.title}`;
}

export function getItemKeyWithoutTitle(item: ShoppingItem | Omit<ShoppingItem, 'id' | 'purchaseStatus'>): string {
  return `${item.circle}|${item.eventDate}|${item.block}|${item.number}`;
}

export function insertItemSorted(items: ShoppingItem[], newItem: ShoppingItem): ShoppingItem[] {
  const newItems = [...items];
  const newItemKey = `${newItem.eventDate}|${newItem.block}|${newItem.number}`;
  
  const sameDayItems = newItems.filter(item => item.eventDate === newItem.eventDate);
  
  let insertIndex = 0;
  for (let i = 0; i < sameDayItems.length; i++) {
    const currentKey = `${sameDayItems[i].eventDate}|${sameDayItems[i].block}|${sameDayItems[i].number}`;
    if (currentKey.localeCompare(newItemKey, 'ja', { numeric: true, sensitivity: 'base' }) > 0) {
      insertIndex = i;
      break;
    }
    insertIndex = i + 1;
  }
  
  const sameDayStartIndex = newItems.findIndex(item => item.eventDate === newItem.eventDate);
  const actualInsertIndex = sameDayStartIndex === -1 ? newItems.length : sameDayStartIndex + insertIndex;
  
  newItems.splice(actualInsertIndex, 0, newItem);
  return newItems;
}
