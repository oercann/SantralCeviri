// Rehber: /etc/ceviri-contacts.json  →  [{ "name": "Onur", "number": "+19082191270", "trusted": true }]
import fs from 'node:fs';
import { normalizeNumber } from './config.js';

const FILE = process.env.CONTACTS_FILE || '/etc/ceviri-contacts.json';
let contacts = [];

export function loadContacts() {
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    contacts = raw.map((c) => ({ name: String(c.name), number: normalizeNumber(c.number), trusted: !!c.trusted }));
    console.log('Rehber yüklendi:', contacts.length, 'kişi');
  } catch (e) {
    contacts = [];
    console.warn('Rehber okunamadı (' + FILE + '):', e.message);
  }
  return contacts;
}

export function allContacts() { return contacts; }

export function findByNumber(number) {
  const n = normalizeNumber(number);
  return contacts.find((c) => c.number === n) || null;
}

const fold = (s) => s.toLocaleLowerCase('tr').replace(/[^a-zçğıöşü0-9]/g, '');
export function findByName(name) {
  const q = fold(name);
  if (!q) return null;
  return contacts.find((c) => fold(c.name) === q) || contacts.find((c) => fold(c.name).startsWith(q)) || null;
}
