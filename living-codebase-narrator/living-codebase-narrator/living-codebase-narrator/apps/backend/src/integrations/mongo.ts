import { MongoClient } from 'mongodb';
import { env } from '../env.js';

let client: MongoClient | null = null;
let connected = false;
let lastError: string | null = null;

export function isMongoConfigured() {
  return Boolean(env.MONGODB_URI);
}

export function mongoState() {
  return { connected, lastError };
}

export async function getMongoClient(): Promise<MongoClient | null> {
  if (!isMongoConfigured()) return null;
  if (client) return client;
  client = new MongoClient(env.MONGODB_URI);
  try {
    await client.connect();
    connected = true;
    lastError = null;
    return client;
  } catch (error) {
    connected = false;
    lastError = String(error);
    return client;
  }
}

