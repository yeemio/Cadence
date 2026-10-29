CREATE FUNCTION guard_mfg_control_event() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='UPDATE' AND OLD.result IS NULL AND NEW.result IS NOT NULL AND (to_jsonb(OLD)-'result')=(to_jsonb(NEW)-'result') THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'manufacturing event is immutable after result finalization';
END; $$;
CREATE TRIGGER mfg_control_event_immutable BEFORE UPDATE OR DELETE ON mfg_control_events FOR EACH ROW EXECUTE FUNCTION guard_mfg_control_event();
CREATE FUNCTION guard_stock_quality_event() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'stock quality event is append-only'; END; $$;
CREATE TRIGGER stock_quality_event_append_only BEFORE UPDATE OR DELETE ON stock_quality_events FOR EACH ROW EXECUTE FUNCTION guard_stock_quality_event();
