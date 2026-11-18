
export const schema = `
CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  handle varchar(24) NOT NULL UNIQUE,
  display_name varchar(48) NOT NULL,
  password_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS sessions (
  digest text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users ON DELETE CASCADE,
  expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS session_expiry ON sessions(expires_at);
CREATE TABLE IF NOT EXISTS videos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users ON DELETE CASCADE,
  caption varchar(500) NOT NULL,
  county varchar(40) NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS videos_feed ON videos(created_at DESC, id DESC);
ALTER TABLE videos ALTER COLUMN county SET DEFAULT '';
ALTER TABLE videos ADD COLUMN IF NOT EXISTS media_storage text NOT NULL DEFAULT 'local'
  CHECK (media_storage IN ('local','r2'));
CREATE TABLE IF NOT EXISTS video_media_cleanup (
  id uuid PRIMARY KEY,
  queued_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS videos_creator ON videos(user_id, created_at DESC);
CREATE TABLE IF NOT EXISTS follows (
  follower_id uuid NOT NULL REFERENCES users ON DELETE CASCADE,
  creator_id uuid NOT NULL REFERENCES users ON DELETE CASCADE,
  PRIMARY KEY(follower_id, creator_id),
  CHECK (follower_id <> creator_id)
);
CREATE INDEX IF NOT EXISTS follows_creator ON follows(creator_id);
CREATE TABLE IF NOT EXISTS likes (
  video_id uuid NOT NULL REFERENCES videos ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users ON DELETE CASCADE,
  PRIMARY KEY(video_id, user_id)
);
CREATE TABLE IF NOT EXISTS saved_videos (
  user_id uuid NOT NULL REFERENCES users ON DELETE CASCADE,
  video_id uuid NOT NULL REFERENCES videos ON DELETE CASCADE,
  saved_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(user_id, video_id)
);
CREATE INDEX IF NOT EXISTS saved_videos_recent ON saved_videos(user_id, saved_at DESC, video_id DESC);
CREATE TABLE IF NOT EXISTS comments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  video_id uuid NOT NULL REFERENCES videos ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users ON DELETE CASCADE,
  body varchar(500) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS comments_video ON comments(video_id, created_at DESC);
CREATE TABLE IF NOT EXISTS messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sender_id uuid NOT NULL REFERENCES users ON DELETE CASCADE,
  recipient_id uuid NOT NULL REFERENCES users ON DELETE CASCADE,
  body varchar(1000) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (sender_id <> recipient_id)
);
CREATE INDEX IF NOT EXISTS messages_sender ON messages(sender_id, recipient_id, created_at DESC);
CREATE INDEX IF NOT EXISTS messages_recipient ON messages(recipient_id, sender_id, created_at DESC);
CREATE TABLE IF NOT EXISTS reports (
  video_id uuid NOT NULL REFERENCES videos ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users ON DELETE CASCADE,
  reason varchar(500) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(video_id, user_id)
);
CREATE TABLE IF NOT EXISTS moderation_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id uuid NOT NULL REFERENCES users,
  video_id uuid NOT NULL,
  action text NOT NULL CHECK (action IN ('dismiss', 'remove')),
  report_count integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);`;
