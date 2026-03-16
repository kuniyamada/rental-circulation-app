-- ユーザー一括登録（画像より）
-- 初期パスワード: 各社員番号 (SHA-256ハッシュ)
-- must_change_password=1 で初回ログイン時にパスワード変更を強制

-- 既存ダミーユーザーを削除（U001〜U003）
DELETE FROM users WHERE employee_number IN ('U001','U002','U003');

-- role凡例:
-- front     = 担当者（フロント担当者）
-- manager   = 管理課/責任者、管理課
-- accounting= 会計課（本社経理）

-- 030: 本橋 美由紀 / 管理課/責任者
INSERT OR IGNORE INTO users (employee_number, name, email, department, role, is_admin, is_active, password_hash, must_change_password)
VALUES ('030', '本橋 美由紀', 'motohashi@tokyod.jp', '管理課', 'manager', 0, 1, 'e3ffdeb85900aefeea9f5d2bc4404df5fabce7071e84e89e7fed1365828d0939', 1);

-- 049: 山崎 修 / 管理課/責任者
INSERT OR IGNORE INTO users (employee_number, name, email, department, role, is_admin, is_active, password_hash, must_change_password)
VALUES ('049', '山崎 修', 'yamazaki@tokyodefense.net', '管理課', 'manager', 0, 1, 'e3ffdeb85900aefeea9f5d2bc4404df5fabce7071e84e89e7fed1365828d0939', 1);

-- 051: 石倉 悦子 / 会計課
INSERT OR IGNORE INTO users (employee_number, name, email, department, role, is_admin, is_active, password_hash, must_change_password)
VALUES ('051', '石倉 悦子', 'ishikura@tokyod.jp', '会計課', 'accounting', 0, 1, 'e3ffdeb85900aefeea9f5d2bc4404df5fabce7071e84e89e7fed1365828d0939', 1);

-- 080: 小林 直矢 / 会計課
INSERT OR IGNORE INTO users (employee_number, name, email, department, role, is_admin, is_active, password_hash, must_change_password)
VALUES ('080', '小林 直矢', 'kobayashi@tokyod.jp', '会計課', 'accounting', 0, 1, 'e3ffdeb85900aefeea9f5d2bc4404df5fabce7071e84e89e7fed1365828d0939', 1);

-- 138: 神原 明香 / 担当者
INSERT OR IGNORE INTO users (employee_number, name, email, department, role, is_admin, is_active, password_hash, must_change_password)
VALUES ('138', '神原 明香', 'kamihara@tokyod.jp', 'フロント', 'front', 0, 1, 'e3ffdeb85900aefeea9f5d2bc4404df5fabce7071e84e89e7fed1365828d0939', 1);

-- 139: 高橋 奈緒美 / 管理課
INSERT OR IGNORE INTO users (employee_number, name, email, department, role, is_admin, is_active, password_hash, must_change_password)
VALUES ('139', '高橋 奈緒美', 'takahashi@tokyod.jp', '管理課', 'manager', 0, 1, 'e3ffdeb85900aefeea9f5d2bc4404df5fabce7071e84e89e7fed1365828d0939', 1);

-- 157: 堀部 和彦 / 担当者/上司
INSERT OR IGNORE INTO users (employee_number, name, email, department, role, is_admin, is_active, password_hash, must_change_password)
VALUES ('157', '堀部 和彦', 'horibe@tokyod.jp', 'フロント', 'front', 0, 1, 'e3ffdeb85900aefeea9f5d2bc4404df5fabce7071e84e89e7fed1365828d0939', 1);

-- 158: 須賀 通友 / 担当者/上司
INSERT OR IGNORE INTO users (employee_number, name, email, department, role, is_admin, is_active, password_hash, must_change_password)
VALUES ('158', '須賀 通友', 'suga@tokyod.jp', 'フロント', 'front', 0, 1, 'e3ffdeb85900aefeea9f5d2bc4404df5fabce7071e84e89e7fed1365828d0939', 1);

-- 165: 小野瀬 宏 / 担当者/上司
INSERT OR IGNORE INTO users (employee_number, name, email, department, role, is_admin, is_active, password_hash, must_change_password)
VALUES ('165', '小野瀬 宏', 'onose@tokyod.jp', 'フロント', 'front', 0, 1, 'e3ffdeb85900aefeea9f5d2bc4404df5fabce7071e84e89e7fed1365828d0939', 1);

-- 167: 小堀 道夫 / 担当者
INSERT OR IGNORE INTO users (employee_number, name, email, department, role, is_admin, is_active, password_hash, must_change_password)
VALUES ('167', '小堀 道夫', 'kobori@tokyod.jp', 'フロント', 'front', 0, 1, 'e3ffdeb85900aefeea9f5d2bc4404df5fabce7071e84e89e7fed1365828d0939', 1);

-- 168: 楠元 一誠 / 担当者
INSERT OR IGNORE INTO users (employee_number, name, email, department, role, is_admin, is_active, password_hash, must_change_password)
VALUES ('168', '楠元 一誠', 'kusumoto@tokyod.jp', 'フロント', 'front', 0, 1, 'e3ffdeb85900aefeea9f5d2bc4404df5fabce7071e84e89e7fed1365828d0939', 1);

-- 172: 串岡 徹哉 / 担当者/上司
INSERT OR IGNORE INTO users (employee_number, name, email, department, role, is_admin, is_active, password_hash, must_change_password)
VALUES ('172', '串岡 徹哉', 'kushioka@tokyod.jp', 'フロント', 'front', 0, 1, 'e3ffdeb85900aefeea9f5d2bc4404df5fabce7071e84e89e7fed1365828d0939', 1);

-- 176: 栃木 政仁 / 不動産部
INSERT OR IGNORE INTO users (employee_number, name, email, department, role, is_admin, is_active, password_hash, must_change_password)
VALUES ('176', '栃木 政仁', 'tochigi@tokyod.jp', '不動産部', 'front', 0, 1, 'e3ffdeb85900aefeea9f5d2bc4404df5fabce7071e84e89e7fed1365828d0939', 1);

-- 180: 宗村 康好 / 担当者/上司
INSERT OR IGNORE INTO users (employee_number, name, email, department, role, is_admin, is_active, password_hash, must_change_password)
VALUES ('180', '宗村 康好', 'munemura@tokyod.jp', 'フロント', 'front', 0, 1, 'e3ffdeb85900aefeea9f5d2bc4404df5fabce7071e84e89e7fed1365828d0939', 1);

-- 186: 贄川 圭介 / 担当者
INSERT OR IGNORE INTO users (employee_number, name, email, department, role, is_admin, is_active, password_hash, must_change_password)
VALUES ('186', '贄川 圭介', 'niekawa@tokyod.jp', 'フロント', 'front', 0, 1, 'e3ffdeb85900aefeea9f5d2bc4404df5fabce7071e84e89e7fed1365828d0939', 1);

-- 187: 田村 ちほ / 担当者
INSERT OR IGNORE INTO users (employee_number, name, email, department, role, is_admin, is_active, password_hash, must_change_password)
VALUES ('187', '田村 ちほ', 'tamura@tokyod.jp', 'フロント', 'front', 0, 1, 'e3ffdeb85900aefeea9f5d2bc4404df5fabce7071e84e89e7fed1365828d0939', 1);

-- 199: 武藤 武士 / 担当者
INSERT OR IGNORE INTO users (employee_number, name, email, department, role, is_admin, is_active, password_hash, must_change_password)
VALUES ('199', '武藤 武士', 'mutou@tokyod.jp', 'フロント', 'front', 0, 1, 'e3ffdeb85900aefeea9f5d2bc4404df5fabce7071e84e89e7fed1365828d0939', 1);

-- 200: 文元 美咲緒 / 担当者
INSERT OR IGNORE INTO users (employee_number, name, email, department, role, is_admin, is_active, password_hash, must_change_password)
VALUES ('200', '文元 美咲緒', 'fumimoto@tokyod.jp', 'フロント', 'front', 0, 1, 'e3ffdeb85900aefeea9f5d2bc4404df5fabce7071e84e89e7fed1365828d0939', 1);

-- 205: 澤田 忠一郎 / 担当者
INSERT OR IGNORE INTO users (employee_number, name, email, department, role, is_admin, is_active, password_hash, must_change_password)
VALUES ('205', '澤田 忠一郎', 'sawada@tokyod.jp', 'フロント', 'front', 0, 1, 'e3ffdeb85900aefeea9f5d2bc4404df5fabce7071e84e89e7fed1365828d0939', 1);

-- 212: 社長 / 担当者/上司
INSERT OR IGNORE INTO users (employee_number, name, email, department, role, is_admin, is_active, password_hash, must_change_password)
VALUES ('212', '社長', 'kunihiro72@gmail.com', '役員', 'front', 0, 1, 'e3ffdeb85900aefeea9f5d2bc4404df5fabce7071e84e89e7fed1365828d0939', 1);

-- 217: 小林 克寿 / 担当者
INSERT OR IGNORE INTO users (employee_number, name, email, department, role, is_admin, is_active, password_hash, must_change_password)
VALUES ('217', '小林 克寿', 'k.kobayashi@tokyod.jp', 'フロント', 'front', 0, 1, 'e3ffdeb85900aefeea9f5d2bc4404df5fabce7071e84e89e7fed1365828d0939', 1);

-- 218: 上野 知秀 / 担当者
INSERT OR IGNORE INTO users (employee_number, name, email, department, role, is_admin, is_active, password_hash, must_change_password)
VALUES ('218', '上野 知秀', 'ueno@tokyod.jp', 'フロント', 'front', 0, 1, 'e3ffdeb85900aefeea9f5d2bc4404df5fabce7071e84e89e7fed1365828d0939', 1);

-- 219: 篠山 恵美 / 会計課
INSERT OR IGNORE INTO users (employee_number, name, email, department, role, is_admin, is_active, password_hash, must_change_password)
VALUES ('219', '篠山 恵美', 'shinoyama@tokyod.jp', '会計課', 'accounting', 0, 1, 'e3ffdeb85900aefeea9f5d2bc4404df5fabce7071e84e89e7fed1365828d0939', 1);

-- 237: 立花 茂朝 / 担当者
INSERT OR IGNORE INTO users (employee_number, name, email, department, role, is_admin, is_active, password_hash, must_change_password)
VALUES ('237', '立花 茂朝', 'tachibana@tokyod.jp', 'フロント', 'front', 0, 1, 'e3ffdeb85900aefeea9f5d2bc4404df5fabce7071e84e89e7fed1365828d0939', 1);

-- 240: 上野 由香子 / 会計課
INSERT OR IGNORE INTO users (employee_number, name, email, department, role, is_admin, is_active, password_hash, must_change_password)
VALUES ('240', '上野 由香子', 'y.ueno@tokyod.jp', '会計課', 'accounting', 0, 1, 'e3ffdeb85900aefeea9f5d2bc4404df5fabce7071e84e89e7fed1365828d0939', 1);

-- 249: 飯坂 友子 / 会計課
INSERT OR IGNORE INTO users (employee_number, name, email, department, role, is_admin, is_active, password_hash, must_change_password)
VALUES ('249', '飯坂 友子', 'iisaka@tokyod.jp', '会計課', 'accounting', 0, 1, 'e3ffdeb85900aefeea9f5d2bc4404df5fabce7071e84e89e7fed1365828d0939', 1);
