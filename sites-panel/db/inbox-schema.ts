// Additive Inbox tables. Re-export from schema.ts for the Drizzle generator.
import {sqliteTable,text,integer,primaryKey,check,index} from 'drizzle-orm/sqlite-core';
import {sql} from 'drizzle-orm';
export const platformMessages=sqliteTable('platform_messages',{
 ownerId:text('owner_id').notNull(),sourceId:text('source_id').notNull(),accountId:text('account_id').notNull(),messageId:text('message_id').notNull(),
 receivedAt:text('received_at').notNull(),recordedAt:text('recorded_at').notNull(),data:text('data').notNull(),externalId:text('external_id').notNull(),panelViewedAt:text('panel_viewed_at'),
},t=>[primaryKey({columns:[t.ownerId,t.sourceId,t.accountId,t.messageId]}),check('platform_messages_data_json',sql`json_valid(${t.data})`),index('platform_messages_recent').on(t.ownerId,t.receivedAt,t.sourceId,t.accountId,t.messageId)]);
export const inboxSyncState=sqliteTable('inbox_sync_state',{
 ownerId:text('owner_id').notNull(),channel:text('channel').notNull(),configFingerprint:text('config_fingerprint').notNull(),mailbox:text('mailbox').notNull(),
 pageCursor:text('page_cursor'),initialComplete:integer('initial_complete').notNull().default(0),leaseId:text('lease_id'),leaseUntil:text('lease_until'),
 status:text('status').notNull(),lastAttempt:text('last_attempt'),lastSuccess:text('last_success'),errorCode:text('error_code'),retryAfterSeconds:integer('retry_after_seconds'),imported:integer('imported').notNull().default(0),skipped:integer('skipped').notNull().default(0),skipReasons:text('skip_reasons').notNull().default('{}'),
},t=>[primaryKey({columns:[t.ownerId,t.channel]}),check('inbox_sync_initial_complete',sql`${t.initialComplete} IN (0,1)`),check('inbox_sync_retry_after',sql`${t.retryAfterSeconds} IS NULL OR ${t.retryAfterSeconds} BETWEEN 0 AND 86400`),check('inbox_sync_skip_reasons_json',sql`json_valid(${t.skipReasons})`)]);
export const mailProviderProvenance=sqliteTable('mail_provider_provenance',{
 ownerId:text('owner_id').notNull(),mailbox:text('mailbox').notNull(),messageId:text('message_id').notNull(),verifiedAt:text('verified_at').notNull(),receiptToStorageMs:integer('receipt_to_storage_ms'),
},t=>[primaryKey({columns:[t.ownerId,t.mailbox,t.messageId]}),check('mail_provider_latency_nonnegative',sql`${t.receiptToStorageMs} IS NULL OR ${t.receiptToStorageMs}>=0`)]);
