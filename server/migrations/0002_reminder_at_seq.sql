-- Phase D (PLAN_V3_SYNC §7.3/§7.4): `at_seq` = the change-log seq of the version that
-- introduced the reminder's current occurrence.
--
-- Why: the mobile dedupe rule compares the device's `scheduled_seq` with "the seq of the
-- reminder". Firing (scheduled → due, D-30) and a desktop pushing `due` give the row a new
-- `seq` without changing the occurrence; comparing with `seq` would then always send a
-- native push and duplicate the local notification the shell already planned. `at_seq`
-- only moves when the occurrence changes: new reminder, different `at`, back to
-- `scheduled` (e.g. set again after done), deleted/undeleted.
--
-- Maintained by triggers so every write path (sync, scheduler, CLI restore) keeps it right
-- without knowing about it. `at` is compared as text here only to detect a *change*;
-- a re-formatted identical instant merely counts as a new occurrence version
-- (conservative: at worst one extra push).

ALTER TABLE reminders ADD COLUMN at_seq INTEGER NULL;

UPDATE reminders SET at_seq = seq;

CREATE TRIGGER reminders_at_seq_insert AFTER INSERT ON reminders
BEGIN
    UPDATE reminders SET at_seq = NEW.seq
     WHERE user_id = NEW.user_id AND note_id = NEW.note_id;
END;

CREATE TRIGGER reminders_at_seq_update AFTER UPDATE OF payload, deleted ON reminders
WHEN NEW.deleted IS NOT OLD.deleted
  OR json_extract(NEW.payload, '$.at') IS NOT json_extract(OLD.payload, '$.at')
  OR (COALESCE(json_extract(NEW.payload, '$.state'), 'scheduled') = 'scheduled'
      AND COALESCE(json_extract(OLD.payload, '$.state'), 'scheduled') <> 'scheduled')
BEGIN
    UPDATE reminders SET at_seq = NEW.seq
     WHERE user_id = NEW.user_id AND note_id = NEW.note_id;
END;
