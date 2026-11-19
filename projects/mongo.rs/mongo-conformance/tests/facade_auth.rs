//! SCRAM 认证状态机与用户、角色管理命令行为测试。
//!
//! 凭证派生与完整 transcript 的期望值由 `node:crypto` 独立生成
//! （固定盐 `0x00..0x0F`、固定 userId `0x10..0x1F`、固定服务器 nonce 扩展
//! `0x20..0x37`），不使用被测实现自产期望值。

use mongo::{
    auth::{
        AuthSession, AuthState, ScriptedEntropy, SupportedMechs, allowed_before_auth, any_user_exists,
        authentication_required, create_role, create_user, drop_role, drop_user, logout,
        sasl_continue, sasl_start, sasl_supported_mechs, users_info,
    },
    bson::{BinaryData, BsonDocument, BsonValue},
    cursor::CursorStore,
    store::Store,
};
use std::sync::atomic::{AtomicU64, Ordering};

static SEQUENCE: AtomicU64 = AtomicU64::new(0);

fn temporary_dir() -> std::path::PathBuf {
    let unique = SEQUENCE.fetch_add(1, Ordering::SeqCst);
    let path = std::env::temp_dir().join(format!("mongo-auth-test-{}-{unique}", std::process::id()));
    let _ = std::fs::remove_dir_all(&path);
    std::fs::create_dir_all(&path).expect("create temp dir");
    path
}

fn store() -> Store {
    Store::open(temporary_dir().join("store.yykv")).expect("open shard")
}

fn text(value: &str) -> BsonValue {
    BsonValue::String(value.to_string())
}

fn command(fields: &[(&str, BsonValue)]) -> BsonDocument {
    let mut document = BsonDocument::new();
    for (key, value) in fields {
        document.push(*key, value.clone());
    }
    document
}

fn array(values: Vec<BsonValue>) -> BsonValue {
    BsonValue::Array(values)
}

fn binary(value: &str) -> BsonValue {
    BsonValue::Binary(BinaryData::new(0x00, value.as_bytes().to_vec()))
}

fn payload_text(reply: &BsonDocument) -> String {
    match reply.get("payload") {
        Some(BsonValue::Binary(data)) => String::from_utf8_lossy(&data.bytes).into_owned(),
        other => panic!("binary payload expected, got {other:?}"),
    }
}

fn field_order(reply: &BsonDocument) -> Vec<&str> {
    reply.fields.iter().map(|(key, _)| key.as_str()).collect()
}

fn assert_error(reply: &BsonDocument, code: i32, code_name: &str, message: &str) {
    assert_eq!(reply.get("ok"), Some(&BsonValue::Double(0.0)), "ok");
    assert_eq!(reply.get("errmsg"), Some(&text(message)), "errmsg: {:?}", reply.get("errmsg"));
    assert_eq!(reply.get("code"), Some(&BsonValue::Int32(code)), "code");
    assert_eq!(reply.get("codeName"), Some(&text(code_name)), "codeName");
    assert_eq!(field_order(reply), vec!["ok", "errmsg", "code", "codeName"]);
}

fn assert_ok(reply: &BsonDocument) {
    assert_eq!(field_order(reply), vec!["ok"]);
    assert_eq!(reply.get("ok"), Some(&BsonValue::Double(1.0)));
}

struct Fixture {
    store: Store,
    cursors: CursorStore,
    auth: AuthState,
    entropy: ScriptedEntropy,
}

impl Fixture {
    fn new() -> Fixture {
        Fixture {
            store: store(),
            cursors: CursorStore::new(),
            auth: AuthState::new(),
            entropy: ScriptedEntropy::new((0u8..64).collect::<Vec<u8>>()),
        }
    }

    fn session(&mut self) -> AuthSession<'_> {
        AuthSession::new(&self.store, &mut self.cursors, &mut self.auth, &mut self.entropy)
    }

    fn create_alice(&mut self) {
        let reply = create_user(
            &mut self.session(),
            &command(&[
                ("createUser", text("alice")),
                ("pwd", text("s3cr3t")),
                ("roles", array(vec![text("read")])),
                ("mechanisms", array(vec![text("SCRAM-SHA-1")])),
                ("$db", text("test")),
            ]),
        );
        assert_ok(&reply);
    }

    fn sasl_start_sha1(&mut self) -> BsonDocument {
        sasl_start(
            &mut self.session(),
            &command(&[
                ("saslStart", BsonValue::Int32(1)),
                ("mechanism", text("SCRAM-SHA-1")),
                ("payload", binary("n,,n=alice,r=clientnonce123")),
                ("$db", text("test")),
            ]),
        )
    }

    fn sasl_continue(&mut self, transcript: &str) -> BsonDocument {
        sasl_continue(
            &mut self.session(),
            &command(&[
                ("saslContinue", BsonValue::Int32(1)),
                ("conversationId", BsonValue::Int32(1)),
                ("payload", binary(transcript)),
            ]),
        )
    }
}

const SERVER_FIRST_SHA1: &str =
    "r=clientnonce123ICEiIyQlJicoKSorLC0uLzAxMjM0NTY3,s=AAECAwQFBgcICQoLDA0ODw==,i=10000";
const CLIENT_FINAL_SHA1: &str =
    "c=biws,r=clientnonce123ICEiIyQlJicoKSorLC0uLzAxMjM0NTY3,p=IVgiS1+T2d4bwTS3dPxXpwOjhug=";
const SERVER_SIGNATURE_SHA1: &str = "v=8AeghrwDKayCbLJtl+dKWTvpyfc=";

#[test]
fn create_user_stores_expected_document_shape() {
    let mut fixture = Fixture::new();
    fixture.create_alice();
    let mut session = fixture.session();
    let reply = users_info(
        &mut session,
        &command(&[
            ("usersInfo", text("alice")),
            ("showCredentials", BsonValue::Bool(true)),
            ("$db", text("test")),
        ]),
    );
    assert_eq!(field_order(&reply), vec!["users", "ok"]);
    let users = match reply.get("users") {
        Some(BsonValue::Array(entries)) => entries.clone(),
        other => panic!("users array expected: {other:?}"),
    };
    let BsonValue::Document(user) = &users[0] else { panic!("user document expected") };
    assert_eq!(
        field_order(user),
        vec!["_id", "userId", "user", "db", "credentials", "roles", "mechanisms"]
    );
    assert_eq!(user.get("_id"), Some(&text("test.alice")));
    match user.get("userId") {
        Some(BsonValue::Binary(data)) => {
            assert_eq!(data.bytes, (16u8..32).collect::<Vec<u8>>());
        }
        other => panic!("binary userId expected: {other:?}"),
    }
    let Some(BsonValue::Document(credentials)) = user.get("credentials") else {
        panic!("credentials expected")
    };
    let Some(BsonValue::Document(sha1)) = credentials.get("SCRAM-SHA-1") else {
        panic!("SCRAM-SHA-1 credentials expected")
    };
    assert_eq!(
        field_order(sha1),
        vec!["iterationCount", "salt", "storedKey", "serverKey"]
    );
    assert_eq!(sha1.get("iterationCount"), Some(&BsonValue::Int32(10_000)));
    assert_eq!(sha1.get("salt"), Some(&text("AAECAwQFBgcICQoLDA0ODw==")));
    assert_eq!(
        sha1.get("storedKey"),
        Some(&text("TT+VUHx/DKKjyYZvK10ouyUkQFs="))
    );
    assert_eq!(
        sha1.get("serverKey"),
        Some(&text("DYpf4eJGN6j2BLSquRUtn3nH2YU="))
    );
}

#[test]
fn scram_sha1_full_conversation_matches_node_transcript() {
    let mut fixture = Fixture::new();
    fixture.create_alice();
    let first = fixture.sasl_start_sha1();
    assert_eq!(field_order(&first), vec!["conversationId", "done", "payload", "ok"]);
    assert_eq!(first.get("conversationId"), Some(&BsonValue::Int32(1)));
    assert_eq!(first.get("done"), Some(&BsonValue::Bool(false)));
    assert_eq!(payload_text(&first), SERVER_FIRST_SHA1);
    let second = fixture.sasl_continue(CLIENT_FINAL_SHA1);
    assert_eq!(field_order(&second), vec!["conversationId", "done", "payload", "ok"]);
    assert_eq!(second.get("done"), Some(&BsonValue::Bool(false)));
    assert_eq!(payload_text(&second), SERVER_SIGNATURE_SHA1);
    let third = fixture.sasl_continue("");
    assert_eq!(third.get("done"), Some(&BsonValue::Bool(true)));
    assert_eq!(payload_text(&third), "");
    let session = fixture.session();
    assert_eq!(session.auth.users.len(), 1);
    assert_eq!(session.auth.users[0].user, "alice");
    assert_eq!(session.auth.users[0].db, "test");
    assert!(session.auth.roles.iter().any(|role| role.role == "read" && role.db == "test"));
}

#[test]
fn sasl_start_rejects_bad_requests() {
    let mut fixture = Fixture::new();
    fixture.create_alice();
    let unknown_mechanism = sasl_start(
        &mut fixture.session(),
        &command(&[
            ("saslStart", BsonValue::Int32(1)),
            ("mechanism", text("SCRAM-MD5")),
            ("payload", binary("n,,n=alice,r=x")),
            ("$db", text("test")),
        ]),
    );
    assert_error(
        &unknown_mechanism,
        334,
        "MechanismUnavailable",
        "Received authentication for mechanism SCRAM-MD5 which is not enabled",
    );
    let missing_mechanism = sasl_start(
        &mut fixture.session(),
        &command(&[("payload", binary("n,,n=alice,r=x"))]),
    );
    assert_error(
        &missing_mechanism,
        40_414,
        "IDLFailedToParse",
        "BSON field 'saslStart.mechanism' is missing but a required field",
    );
    let missing_payload = sasl_start(
        &mut fixture.session(),
        &command(&[("mechanism", text("SCRAM-SHA-1"))]),
    );
    assert_error(
        &missing_payload,
        40_414,
        "IDLFailedToParse",
        "BSON field 'saslStart.payload' is missing but a required field",
    );
    let bad_base64 = sasl_start(
        &mut fixture.session(),
        &command(&[
            ("mechanism", text("SCRAM-SHA-1")),
            ("payload", text("!!!not base64!!!")),
        ]),
    );
    assert_error(
        &bad_base64,
        10_270,
        "Location10270",
        "Failed decoding SASL payload: invalid base64",
    );
    let unknown_user = sasl_start(
        &mut fixture.session(),
        &command(&[
            ("mechanism", text("SCRAM-SHA-1")),
            ("payload", binary("n,,n=ghost,r=x")),
            ("$db", text("test")),
        ]),
    );
    assert_error(&unknown_user, 18, "AuthenticationFailed", "Authentication failed.");
    let bad_gs2 = sasl_start(
        &mut fixture.session(),
        &command(&[
            ("mechanism", text("SCRAM-SHA-1")),
            ("payload", binary("p=n,,n=alice,r=x")),
            ("$db", text("test")),
        ]),
    );
    assert_error(&bad_gs2, 18, "AuthenticationFailed", "Authentication failed.");
    let mismatched_authzid = sasl_start(
        &mut fixture.session(),
        &command(&[
            ("mechanism", text("SCRAM-SHA-1")),
            ("payload", binary("n,a=admin,n=alice,r=x")),
            ("$db", text("test")),
        ]),
    );
    assert_error(&mismatched_authzid, 18, "AuthenticationFailed", "Authentication failed.");
}

#[test]
fn wrong_proof_clears_conversation() {
    let mut fixture = Fixture::new();
    fixture.create_alice();
    let _ = fixture.sasl_start_sha1();
    let tampered = "c=biws,r=clientnonce123ICEiIyQlJicoKSorLC0uLzAxMjM0NTY3,p=AAAAAAAAAAAAAAAAAAAAAAAAAA==";
    let reply = fixture.sasl_continue(tampered);
    assert_error(&reply, 18, "AuthenticationFailed", "Authentication failed.");
    let follow_up = fixture.sasl_continue(CLIENT_FINAL_SHA1);
    assert_error(&follow_up, 17, "ProtocolError", "No SASL session state found");
}

#[test]
fn sasl_continue_requires_live_conversation() {
    let mut fixture = Fixture::new();
    let missing = fixture.sasl_continue(CLIENT_FINAL_SHA1);
    assert_error(&missing, 17, "ProtocolError", "No SASL session state found");
    fixture.create_alice();
    let _ = fixture.sasl_start_sha1();
    let session = fixture.session();
    assert!(session.auth.conversation.is_some());
    let wrong_identifier = sasl_continue(
        &mut fixture.session(),
        &command(&[
            ("conversationId", BsonValue::Int32(2)),
            ("payload", binary(CLIENT_FINAL_SHA1)),
        ]),
    );
    assert_error(&wrong_identifier, 17, "ProtocolError", "No SASL session state found");
    let bad_payload = sasl_continue(
        &mut fixture.session(),
        &command(&[
            ("conversationId", BsonValue::Int32(1)),
            ("payload", text("!!!not base64!!!")),
        ]),
    );
    assert_error(
        &bad_payload,
        10_270,
        "Location10270",
        "Failed decoding SASL payload: invalid base64",
    );
}

#[test]
fn create_user_validation_errors() {
    let mut fixture = Fixture::new();
    let mut session = fixture.session();
    let missing_pwd = create_user(
        &mut session,
        &command(&[("createUser", text("bob")), ("roles", array(Vec::new())), ("$db", text("test"))]),
    );
    assert_error(
        &missing_pwd,
        40_414,
        "IDLFailedToParse",
        "BSON field 'createUser.pwd' is missing but a required field",
    );
    let bad_name = create_user(&mut session, &command(&[("createUser", BsonValue::Int32(1))]));
    assert_error(&bad_name, 2, "BadValue", "createUser must be a string");
    let bad_mechanism = create_user(
        &mut session,
        &command(&[
            ("createUser", text("bob")),
            ("pwd", text("x")),
            ("roles", array(Vec::new())),
            ("mechanisms", array(vec![text("SCRAM-MD5")])),
            ("$db", text("test")),
        ]),
    );
    assert_error(&bad_mechanism, 2, "BadValue", "Unknown auth mechanism 'SCRAM-MD5'");
    let empty_mechanisms = create_user(
        &mut session,
        &command(&[
            ("createUser", text("bob")),
            ("pwd", text("x")),
            ("roles", array(Vec::new())),
            ("mechanisms", array(Vec::new())),
            ("$db", text("test")),
        ]),
    );
    assert_error(&empty_mechanisms, 2, "BadValue", "mechanisms must not be empty");
    let bidi_password = create_user(
        &mut session,
        &command(&[
            ("createUser", text("bob")),
            ("pwd", text("a\u{05D0}")),
            ("roles", array(Vec::new())),
            ("$db", text("test")),
        ]),
    );
    assert_error(
        &bidi_password,
        50_692,
        "Location50692",
        "Error preflighting normalization: U_STRINGPREP_CHECK_BIDI_ERROR",
    );
    let prohibited_password = create_user(
        &mut session,
        &command(&[
            ("createUser", text("bob")),
            ("pwd", text("a\u{0007}")),
            ("roles", array(Vec::new())),
            ("$db", text("test")),
        ]),
    );
    assert_error(
        &prohibited_password,
        50_692,
        "Location50692",
        "Error preflighting normalization: U_STRINGPREP_PROHIBITED_ERROR",
    );
    let unknown_role = create_user(
        &mut session,
        &command(&[
            ("createUser", text("bob")),
            ("pwd", text("x")),
            ("roles", array(vec![text("ghost")])),
            ("$db", text("test")),
        ]),
    );
    assert_error(&unknown_role, 31, "RoleNotFound", "Could not find role: ghost@test");
    drop(session);
    fixture.create_alice();
    let mut session = fixture.session();
    let duplicate = create_user(
        &mut session,
        &command(&[
            ("createUser", text("alice")),
            ("pwd", text("x")),
            ("roles", array(Vec::new())),
            ("$db", text("test")),
        ]),
    );
    assert_error(&duplicate, 51_003, "Location51003", "User \"alice@test\" already exists");
}

#[test]
fn drop_user_errors_and_success() {
    let mut fixture = Fixture::new();
    let mut session = fixture.session();
    let missing = drop_user(&mut session, &command(&[("dropUser", text("ghost")), ("$db", text("test"))]));
    assert_error(&missing, 11, "UserNotFound", "User 'ghost@test' not found");
    let bad_name = drop_user(&mut session, &command(&[("dropUser", BsonValue::Int32(1))]));
    assert_error(&bad_name, 2, "BadValue", "dropUser must be a string");
    drop(session);
    fixture.create_alice();
    assert!(any_user_exists(&fixture.store));
    let mut session = fixture.session();
    assert_ok(&drop_user(&mut session, &command(&[("dropUser", text("alice")), ("$db", text("test"))])));
    drop(session);
    assert!(!any_user_exists(&fixture.store));
}

#[test]
fn create_role_validation_errors() {
    let mut fixture = Fixture::new();
    let mut session = fixture.session();
    let unknown_field = create_role(
        &mut session,
        &command(&[
            ("createRole", text("app")),
            ("privileges", array(Vec::new())),
            ("roles", array(Vec::new())),
            ("bogus", BsonValue::Int32(1)),
            ("$db", text("test")),
        ]),
    );
    assert_error(
        &unknown_field,
        40_415,
        "IDLUnknownField",
        "BSON field 'createRole.bogus' is an unknown field.",
    );
    let missing_privileges = create_role(
        &mut session,
        &command(&[("createRole", text("app")), ("roles", array(Vec::new())), ("$db", text("test"))]),
    );
    assert_error(
        &missing_privileges,
        40_414,
        "IDLFailedToParse",
        "BSON field 'createRole.privileges' is missing but a required field",
    );
    let built_in_name = create_role(
        &mut session,
        &command(&[
            ("createRole", text("read")),
            ("privileges", array(Vec::new())),
            ("roles", array(Vec::new())),
            ("$db", text("test")),
        ]),
    );
    assert_error(
        &built_in_name,
        2,
        "BadValue",
        "Cannot create roles with the same name as a built-in role",
    );
    let empty_name = create_role(
        &mut session,
        &command(&[
            ("createRole", text("")),
            ("privileges", array(Vec::new())),
            ("roles", array(Vec::new())),
            ("$db", text("test")),
        ]),
    );
    assert_error(&empty_name, 2, "BadValue", "Role name must be non-empty");
    let self_grant = create_role(
        &mut session,
        &command(&[
            ("createRole", text("app")),
            ("privileges", array(Vec::new())),
            ("roles", array(vec![text("app")])),
            ("$db", text("test")),
        ]),
    );
    assert_error(
        &self_grant,
        49,
        "InvalidRoleModification",
        "Cannot grant role app@test to itself.",
    );
    let cross_database = create_role(
        &mut session,
        &command(&[
            ("createRole", text("app")),
            ("privileges", array(Vec::new())),
            ("roles", array(vec![BsonValue::Document(command(&[
                ("role", text("read")),
                ("db", text("other")),
            ]))])),
            ("$db", text("test")),
        ]),
    );
    assert_error(
        &cross_database,
        49,
        "InvalidRoleModification",
        "Roles on the 'test' database cannot be granted roles from other databases",
    );
    let bad_action = create_role(
        &mut session,
        &command(&[
            ("createRole", text("app")),
            (
                "privileges",
                array(vec![BsonValue::Document(command(&[
                    ("resource", BsonValue::Document(command(&[("db", text("test")), ("collection", text(""))]))),
                    ("actions", array(vec![text("bogus")])),
                ]))]),
            ),
            ("roles", array(Vec::new())),
            ("$db", text("test")),
        ]),
    );
    assert_error(&bad_action, 2, "BadValue", "Unknown action type in privilege set: 'bogus'");
    let empty_actions = create_role(
        &mut session,
        &command(&[
            ("createRole", text("app")),
            (
                "privileges",
                array(vec![BsonValue::Document(command(&[
                    ("resource", BsonValue::Document(command(&[("db", text("test")), ("collection", text(""))]))),
                    ("actions", array(Vec::new())),
                ]))]),
            ),
            ("roles", array(Vec::new())),
            ("$db", text("test")),
        ]),
    );
    assert_error(
        &empty_actions,
        2,
        "BadValue",
        "'actions' field of privilege resource must not be empty",
    );
    let out_of_scope = create_role(
        &mut session,
        &command(&[
            ("createRole", text("app")),
            (
                "privileges",
                array(vec![BsonValue::Document(command(&[
                    ("resource", BsonValue::Document(command(&[("cluster", BsonValue::Bool(true))]))),
                    ("actions", array(vec![text("find")])),
                ]))]),
            ),
            ("roles", array(Vec::new())),
            ("$db", text("test")),
        ]),
    );
    assert_error(
        &out_of_scope,
        49,
        "InvalidRoleModification",
        "Roles on the 'test' database cannot be granted privileges that target other databases or the cluster",
    );
    let bad_role_name = create_role(
        &mut session,
        &command(&[
            ("createRole", text("app")),
            ("privileges", array(Vec::new())),
            (
                "roles",
                array(vec![BsonValue::Document(command(&[("role", BsonValue::Int32(1))]))]),
            ),
            ("$db", text("test")),
        ]),
    );
    assert_error(
        &bad_role_name,
        2,
        "BadValue",
        "RoleName must contain a string field named: role. But, has type int",
    );
}

#[test]
fn create_role_success_then_drop_role_strips_references() {
    let mut fixture = Fixture::new();
    let mut session = fixture.session();
    assert_ok(&create_role(
        &mut session,
        &command(&[
            ("createRole", text("app")),
            (
                "privileges",
                array(vec![BsonValue::Document(command(&[
                    (
                        "resource",
                        BsonValue::Document(command(&[("db", text("test")), ("collection", text("c"))])),
                    ),
                    ("actions", array(vec![text("find")])),
                ]))]),
            ),
            ("roles", array(Vec::new())),
            ("$db", text("test")),
        ]),
    ));
    drop(session);
    let mut session = fixture.session();
    assert_ok(&create_user(
        &mut session,
        &command(&[
            ("createUser", text("bob")),
            ("pwd", text("hunter2")),
            ("roles", array(vec![text("app")])),
            ("$db", text("test")),
        ]),
    ));
    drop(session);
    let mut session = fixture.session();
    let duplicate = create_role(
        &mut session,
        &command(&[
            ("createRole", text("app")),
            ("privileges", array(Vec::new())),
            ("roles", array(Vec::new())),
            ("$db", text("test")),
        ]),
    );
    assert_error(&duplicate, 51_002, "Location51002", "Role \"app@test\" already exists");
    drop(session);
    let mut session = fixture.session();
    assert_ok(&drop_role(
        &mut session,
        &command(&[("dropRole", text("app")), ("$db", text("test"))]),
    ));
    drop(session);
    let mut session = fixture.session();
    let reply = users_info(&mut session, &command(&[("usersInfo", text("bob")), ("$db", text("test"))]));
    let Some(BsonValue::Array(users)) = reply.get("users") else { panic!("users expected") };
    let BsonValue::Document(bob) = &users[0] else { panic!("document expected") };
    assert_eq!(bob.get("roles"), Some(&array(Vec::new())));
    drop(session);
    let mut session = fixture.session();
    let missing_role = drop_role(
        &mut session,
        &command(&[("dropRole", text("app")), ("$db", text("test"))]),
    );
    assert_error(&missing_role, 31, "RoleNotFound", "Could not find role: app@test");
    let built_in = drop_role(
        &mut session,
        &command(&[("dropRole", text("read")), ("$db", text("test"))]),
    );
    assert_error(
        &built_in,
        2,
        "BadValue",
        "read@test is a built-in role and cannot be modified",
    );
}

#[test]
fn users_info_reports_and_selections() {
    let mut fixture = Fixture::new();
    fixture.create_alice();
    let mut session = fixture.session();
    let reply = users_info(&mut session, &command(&[("usersInfo", text("alice")), ("$db", text("test"))]));
    let Some(BsonValue::Array(users)) = reply.get("users") else { panic!("users expected") };
    let BsonValue::Document(report) = &users[0] else { panic!("document expected") };
    assert_eq!(
        field_order(report),
        vec!["_id", "userId", "user", "db", "roles", "mechanisms"]
    );
    assert_eq!(
        report.get("mechanisms"),
        Some(&array(vec![text("SCRAM-SHA-1")]))
    );
    drop(session);

    let mut session = fixture.session();
    let with_credentials = users_info(
        &mut session,
        &command(&[
            ("usersInfo", text("alice")),
            ("showCredentials", BsonValue::Bool(true)),
            ("$db", text("test")),
        ]),
    );
    let Some(BsonValue::Array(users)) = with_credentials.get("users") else { panic!("users expected") };
    let BsonValue::Document(report) = &users[0] else { panic!("document expected") };
    assert_eq!(
        field_order(report),
        vec!["_id", "userId", "user", "db", "credentials", "roles", "mechanisms"]
    );
    drop(session);

    let mut session = fixture.session();
    let with_privileges = users_info(
        &mut session,
        &command(&[
            ("usersInfo", text("alice")),
            ("showPrivileges", BsonValue::Bool(true)),
            ("$db", text("test")),
        ]),
    );
    let Some(BsonValue::Array(users)) = with_privileges.get("users") else { panic!("users expected") };
    let BsonValue::Document(report) = &users[0] else { panic!("document expected") };
    assert_eq!(
        field_order(report),
        vec![
            "_id",
            "userId",
            "user",
            "db",
            "mechanisms",
            "roles",
            "inheritedRoles",
            "inheritedPrivileges",
            "inheritedAuthenticationRestrictions"
        ]
    );
    drop(session);

    let mut session = fixture.session();
    let unknown_field = users_info(
        &mut session,
        &command(&[
            (
                "usersInfo",
                BsonValue::Document(command(&[("bogus", BsonValue::Bool(true))])),
            ),
            ("$db", text("test")),
        ]),
    );
    assert_error(
        &unknown_field,
        2,
        "BadValue",
        "UserName contains an unknown field named: 'bogus",
    );
    let all_in_db = users_info(
        &mut session,
        &command(&[("usersInfo", BsonValue::Int32(1)), ("$db", text("test"))]),
    );
    let Some(BsonValue::Array(users)) = all_in_db.get("users") else { panic!("users expected") };
    assert_eq!(users.len(), 1);
    let all_databases = users_info(
        &mut session,
        &command(&[
            (
                "usersInfo",
                BsonValue::Document(command(&[("forAllDBs", BsonValue::Bool(true))])),
            ),
            ("$db", text("test")),
        ]),
    );
    let Some(BsonValue::Array(users)) = all_databases.get("users") else { panic!("users expected") };
    assert_eq!(users.len(), 1);
    let empty_or = users_info(
        &mut session,
        &command(&[("usersInfo", array(Vec::new())), ("$db", text("test"))]),
    );
    assert_error(&empty_or, 2, "BadValue", "$or argument must be a non-empty array");
}

#[test]
fn sasl_supported_mechs_and_logout_and_pre_auth() {
    let mut fixture = Fixture::new();
    let mut session = fixture.session();
    let malformed = sasl_supported_mechs(&mut session, &text("no-dot"));
    match malformed {
        SupportedMechs::Error(error) => assert_error(
            &error,
            2,
            "BadValue",
            "UserName must contain a '.' separated database.user pair",
        ),
        other => panic!("error expected: {other:?}"),
    }
    let absent = sasl_supported_mechs(&mut session, &text("test.alice"));
    assert!(matches!(absent, SupportedMechs::None));
    drop(session);
    fixture.create_alice();
    let mut session = fixture.session();
    let mechanisms = sasl_supported_mechs(&mut session, &text("test.alice"));
    match mechanisms {
        SupportedMechs::Mechanisms(names) => assert_eq!(names, vec!["SCRAM-SHA-1".to_string()]),
        other => panic!("mechanisms expected: {other:?}"),
    }
    let _ = fixture.sasl_start_sha1();
    let _ = fixture.sasl_continue(CLIENT_FINAL_SHA1);
    let _ = fixture.sasl_continue("");
    let mut session = fixture.session();
    assert_eq!(session.auth.users.len(), 1);
    assert_ok(&logout(&mut session));
    assert!(session.auth.users.is_empty());
    assert!(session.auth.roles.is_empty());
    drop(session);
    assert!(allowed_before_auth("saslStart"));
    assert!(!allowed_before_auth("find"));
    let required = authentication_required("find");
    assert_error(&required, 13, "Unauthorized", "Command find requires authentication");
}

#[test]
fn create_user_default_mechanisms_register_both() {
    let mut fixture = Fixture::new();
    let mut session = fixture.session();
    assert_ok(&create_user(
        &mut session,
        &command(&[
            ("createUser", text("carol")),
            ("pwd", text("s3cr3t")),
            ("roles", array(Vec::new())),
            ("$db", text("test")),
        ]),
    ));
    drop(session);
    let mut session = fixture.session();
    let reply = users_info(
        &mut session,
        &command(&[("usersInfo", text("carol")), ("$db", text("test"))]),
    );
    let Some(BsonValue::Array(users)) = reply.get("users") else { panic!("users expected") };
    let BsonValue::Document(report) = &users[0] else { panic!("document expected") };
    assert_eq!(
        report.get("mechanisms"),
        Some(&array(vec![text("SCRAM-SHA-1"), text("SCRAM-SHA-256")]))
    );
}
