import { createMemoryConversationStore } from './conversationStore/memoryStore.ts';
import { createPgConversationStore } from './conversationStore/pgStore.ts';

function createConversationStore({
  conversationStore,
  db = null,
}: {
  conversationStore?: import('./conversationStore/types.ts').ConversationStore;
  db?: import('../db/client.ts').Database | null;
} = {}): import('./conversationStore/types.ts').ConversationStore {
  if (conversationStore) return conversationStore;
  return db ? createPgConversationStore(db) : createMemoryConversationStore();
}

export {
  createConversationStore,
  createMemoryConversationStore,
  createPgConversationStore,
};
export type {
  ConversationChange,
  ConversationMember,
  ConversationRole,
  ConversationSnapshot,
  ConversationStore,
  GroupCall,
  GroupCallChange,
  GroupCallParticipant,
  GroupConversation,
} from './conversationStore/types.ts';
export { ConversationStoreError } from './conversationStore/types.ts';
