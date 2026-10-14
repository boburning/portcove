use super::*;
use crate::process::{ChildProcessClass, ChildProcessPolicy, DecoderLimits};
use std::{fs, os::unix::process::CommandExt, process::Command};

fn specification(root: &std::path::Path, mode: &str) -> NativeToolLaunchSpec {
    let mut specification = ChildProcessPolicy::native_tool_spec(
        ChildProcessClass::HostTool,
        std::env::current_exe().unwrap(),
    )
    .unwrap();
    specification.args([
        "--exact",
        "tool_process::linux::tests::namespace_fixture_child",
        "--ignored",
        "--nocapture",
    ]);
    specification.env("PORTCOVE_NAMESPACE_FIXTURE_ROOT", root);
    specification.env("PORTCOVE_NAMESPACE_FIXTURE_MODE", mode);
    specification.decoder_limits = Some(DecoderLimits {
        memory_bytes: 512 * 1024 * 1024,
        file_bytes: 4 * 1024 * 1024,
    });
    specification
}

#[test]
#[ignore = "owned child entrypoint; run only through the supervised parent control"]
fn namespace_fixture_child() {
    let root =
        std::path::PathBuf::from(std::env::var_os("PORTCOVE_NAMESPACE_FIXTURE_ROOT").unwrap());
    let mode = std::env::var("PORTCOVE_NAMESPACE_FIXTURE_MODE").unwrap();
    if mode == "unsupported-clone" {
        let mut filter = [
            libc::sock_filter {
                code: (libc::BPF_LD | libc::BPF_W | libc::BPF_ABS) as u16,
                jt: 0,
                jf: 0,
                k: 0,
            },
            libc::sock_filter {
                code: (libc::BPF_JMP | libc::BPF_JEQ | libc::BPF_K) as u16,
                jt: 0,
                jf: 1,
                k: libc::SYS_clone3 as u32,
            },
            libc::sock_filter {
                code: (libc::BPF_RET | libc::BPF_K) as u16,
                jt: 0,
                jf: 0,
                k: libc::SECCOMP_RET_ERRNO | libc::EPERM as u32,
            },
            libc::sock_filter {
                code: (libc::BPF_RET | libc::BPF_K) as u16,
                jt: 0,
                jf: 0,
                k: libc::SECCOMP_RET_ALLOW,
            },
        ];
        let program = libc::sock_fprog {
            len: filter.len() as u16,
            filter: filter.as_mut_ptr(),
        };
        assert_eq!(
            unsafe { libc::prctl(libc::PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) },
            0
        );
        assert_eq!(
            unsafe { libc::prctl(libc::PR_SET_SECCOMP, libc::SECCOMP_MODE_FILTER, &program) },
            0
        );
        let failure = spawn_tool(&specification(&root, "normal"))
            .err()
            .expect("clone must be rejected");
        assert!(failure.quiesced);
        assert_eq!(failure.io_kind, Some(io::ErrorKind::PermissionDenied));
        assert!(!root.join("descendant-ready").exists());
        return;
    }
    if mode == "controller" {
        let (_child, _group) = spawn_tool(&specification(&root, "detached"))
            .unwrap_or_else(|failure| panic!("{}", failure.error.message));
        fs::write(
            root.join("controller-ready"),
            b"registered namespace custody",
        )
        .unwrap();
        std::thread::sleep(Duration::from_secs(8));
        return;
    }
    if mode == "closed-stdio" {
        // Isolate process-global signal dispositions and stdio changes in this
        // owned helper, never in the parallel test runner.
        let descriptor = unsafe { libc::open(c"/dev/null".as_ptr(), libc::O_RDONLY) };
        assert!(descriptor >= 0);
        let descriptor = unsafe { libc::fcntl(descriptor, libc::F_DUPFD, 500) };
        assert!(descriptor >= 500);
        let mut launch = specification(&root, "environment");
        launch.env("PORTCOVE_NAMESPACE_FORBIDDEN_FD", descriptor.to_string());
        unsafe {
            libc::signal(libc::SIGUSR2, libc::SIG_IGN);
            let mut mask: libc::sigset_t = std::mem::zeroed();
            libc::sigemptyset(&mut mask);
            libc::sigaddset(&mut mask, libc::SIGUSR1);
            libc::pthread_sigmask(libc::SIG_BLOCK, &mask, std::ptr::null_mut());
            for descriptor in 0..3 {
                libc::close(descriptor);
            }
        }
        let result = super::super::run_tool(
            &mut launch,
            &|| Ok(()),
            super::super::ToolProcessObserver::default(),
        )
        .unwrap();
        assert!(result.status.success());
        fs::write(
            root.join("closed-stdio-passed"),
            b"child signal and fd checks passed",
        )
        .unwrap();
        return;
    }
    if mode == "descendant" {
        let actual = fs::read_to_string("/proc/self/stat")
            .unwrap()
            .split_whitespace()
            .next()
            .unwrap()
            .to_owned();
        fs::write(root.join("descendant-ready"), actual).unwrap();
        let deadline = Instant::now() + Duration::from_secs(30);
        let mut counter = 0;
        while Instant::now() < deadline {
            counter += 1;
            fs::write(root.join("descendant-writes"), counter.to_string()).unwrap();
            std::thread::sleep(Duration::from_millis(10));
        }
        fs::write(root.join("descendant-unexpected-completion"), b"unexpected").unwrap();
        return;
    }
    assert_eq!(unsafe { libc::getpid() }, 1);
    assert_eq!(unsafe { libc::geteuid() }, 0);
    if mode == "limits" {
        let mut bound: libc::rlimit = unsafe { std::mem::zeroed() };
        assert_eq!(unsafe { libc::getrlimit(libc::RLIMIT_AS, &mut bound) }, 0);
        assert_eq!(bound.rlim_max, 512 * 1024 * 1024);
        assert_eq!(
            unsafe { libc::getrlimit(libc::RLIMIT_FSIZE, &mut bound) },
            0
        );
        assert_eq!(bound.rlim_max, 4 * 1024 * 1024);
        let memory = unsafe {
            libc::mmap(
                std::ptr::null_mut(),
                1024 * 1024 * 1024,
                libc::PROT_READ | libc::PROT_WRITE,
                libc::MAP_PRIVATE | libc::MAP_ANONYMOUS,
                -1,
                0,
            )
        };
        assert_eq!(memory, libc::MAP_FAILED);
        fs::write(root.join("memory-limit-observed"), b"allocation denied").unwrap();
        // The hard per-file bound terminates this actual excessive write.
        fs::write(root.join("bounded-output"), vec![0_u8; 5 * 1024 * 1024]).unwrap();
        panic!("file limit did not terminate writer");
    }
    if mode == "environment" {
        let mut mask: libc::sigset_t = unsafe { std::mem::zeroed() };
        assert_eq!(
            unsafe { libc::pthread_sigmask(libc::SIG_SETMASK, std::ptr::null(), &mut mask) },
            0
        );
        assert_eq!(unsafe { libc::sigismember(&mask, libc::SIGUSR1) }, 0);
        let mut action: libc::sigaction = unsafe { std::mem::zeroed() };
        assert_eq!(
            unsafe { libc::sigaction(libc::SIGPIPE, std::ptr::null(), &mut action) },
            0
        );
        // Rust itself ignores SIGPIPE after exec, so inspect SIGUSR2 instead.
        assert_eq!(
            unsafe { libc::sigaction(libc::SIGUSR2, std::ptr::null(), &mut action) },
            0
        );
        assert_eq!(action.sa_sigaction, libc::SIG_DFL);
        if let Some(value) = std::env::var_os("PORTCOVE_NAMESPACE_FORBIDDEN_FD") {
            assert_eq!(
                unsafe {
                    libc::fcntl(
                        value.to_str().unwrap().parse::<i32>().unwrap(),
                        libc::F_GETFD,
                    )
                },
                -1
            );
        }
        return;
    }
    if mode == "normal" {
        fs::write(
            root.join("admitted-executable-started"),
            b"started after acknowledgement",
        )
        .unwrap();
        println!("actual namespace init completed");
        return;
    }
    let mut descendant = Command::new(std::env::current_exe().unwrap());
    descendant.args([
        "--exact",
        "tool_process::linux::tests::namespace_fixture_child",
        "--ignored",
        "--nocapture",
    ]);
    descendant.env("PORTCOVE_NAMESPACE_FIXTURE_MODE", "descendant");
    // Escape the ordinary process group while remaining in the owned namespace.
    unsafe {
        descendant.pre_exec(move || {
            if libc::setsid() < 0 {
                return Err(io::Error::last_os_error());
            }
            match mode.as_str() {
                "double-fork" => {
                    let forked = libc::fork();
                    if forked < 0 {
                        return Err(io::Error::last_os_error());
                    }
                    if forked > 0 {
                        libc::_exit(0);
                    }
                }
                "nested" => {
                    if libc::unshare(libc::CLONE_NEWPID) != 0 {
                        return Err(io::Error::last_os_error());
                    }
                    let forked = libc::fork();
                    if forked < 0 {
                        return Err(io::Error::last_os_error());
                    }
                    if forked > 0 {
                        libc::_exit(0);
                    }
                }
                _ => {}
            }
            Ok(())
        });
    }
    let _descendant = descendant.spawn().unwrap();
    let deadline = Instant::now() + Duration::from_secs(30);
    while !root.join("descendant-ready").is_file() || !root.join("release-init").is_file() {
        assert!(Instant::now() < deadline, "owned init was not released");
        std::thread::sleep(Duration::from_millis(10));
    }
}

#[test]
fn namespace_normal_completion_has_a_pidfd_bound_join() {
    let temporary = tempfile::tempdir().unwrap();
    let mut specification = specification(temporary.path(), "normal");
    let closed = std::cell::Cell::new(false);
    let mut confirm = || {
        closed.set(true);
        Ok(())
    };
    let result = super::super::run_tool(
        &mut specification,
        &|| Ok(()),
        super::super::ToolProcessObserver {
            diagnostics: None,
            quiesced: Some(&mut confirm),
        },
    )
    .unwrap();
    assert!(result.status.success());
    assert_eq!(
        result.process_tree_proof["process_tree_proof_method"],
        "clone3_namespace_init_pidfd_waitid"
    );
    assert!(result.output.contains("actual namespace init completed"));
    assert!(closed.get());
}

#[test]
fn namespace_init_exit_closes_a_detached_writer_before_publication() {
    detached_writer_control("detached", false, false);
}

#[test]
fn namespace_init_exit_closes_double_fork_and_nested_namespace_writers() {
    detached_writer_control("double-fork", false, false);
    detached_writer_control("nested", false, false);
}

#[test]
fn namespace_cancellation_joins_detached_writer_and_preserves_unrelated_sentinel() {
    detached_writer_control("detached", true, false);
}

#[test]
fn namespace_unwinding_drops_live_custody_without_late_writes() {
    detached_writer_control("detached", false, true);
}

fn detached_writer_control(mode: &str, cancel: bool, unwind: bool) {
    let temporary = tempfile::tempdir().unwrap();
    let mut specification = specification(temporary.path(), mode);
    // This separately owned process is outside the namespace and must survive.
    let mut sentinel = Command::new("/bin/sleep").arg("15").spawn().unwrap();
    let mut retained: Option<OwnedFd> = None;
    let mut checkpoint = || {
        if retained.is_none()
            && let Ok(pid) = fs::read_to_string(temporary.path().join("descendant-ready"))
        {
            let descriptor = unsafe {
                libc::syscall(libc::SYS_pidfd_open, pid.trim().parse::<i32>().unwrap(), 0)
            };
            assert!(descriptor >= 0);
            retained = Some(unsafe { OwnedFd::from_raw_fd(descriptor as RawFd) });
            if unwind {
                panic!("owned active-child unwind control");
            }
            if cancel {
                return Err(PortcoveError::new(
                    crate::ErrorCode::Cancelled,
                    "owned cancellation",
                ));
            }
            fs::write(
                temporary.path().join("release-init"),
                b"exact descendant handle retained",
            )
            .unwrap();
        }
        Ok(())
    };
    // The callback interface is Fn: interior mutability keeps ownership explicit.
    let callback = std::cell::RefCell::new(&mut checkpoint);
    let closed = std::cell::Cell::new(false);
    let mut confirm = || {
        closed.set(true);
        Ok(())
    };
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        super::super::run_tool(
            &mut specification,
            &|| (callback.borrow_mut())(),
            super::super::ToolProcessObserver {
                diagnostics: None,
                quiesced: Some(&mut confirm),
            },
        )
    }));
    if unwind {
        assert!(result.is_err());
        assert!(!closed.get());
    } else if cancel {
        let error = result.unwrap().err().expect("cancelled decoder");
        assert_eq!(error.code, crate::ErrorCode::Cancelled);
        assert_eq!(error.details["process_tree_active"], "0");
        assert!(closed.get());
    } else {
        assert!(result.unwrap().unwrap().status.success());
        assert!(closed.get());
    }
    drop(callback);
    drop(checkpoint);
    let descriptor = retained.unwrap();
    let mut observed = libc::pollfd {
        fd: descriptor.as_raw_fd(),
        events: libc::POLLIN,
        revents: 0,
    };
    assert_eq!(unsafe { libc::poll(&mut observed, 1, 0) }, 1);
    assert_ne!(observed.revents & libc::POLLIN, 0);
    let count = fs::read(temporary.path().join("descendant-writes")).unwrap();
    std::thread::sleep(Duration::from_millis(50));
    assert_eq!(
        fs::read(temporary.path().join("descendant-writes")).unwrap(),
        count
    );
    assert!(
        !temporary
            .path()
            .join("descendant-unexpected-completion")
            .exists()
    );
    assert!(sentinel.try_wait().unwrap().is_none());
    sentinel.kill().unwrap();
    sentinel.wait().unwrap();
}

#[test]
fn namespace_hard_limits_bound_actual_allocation_and_file_writes() {
    let temporary = tempfile::tempdir().unwrap();
    let result = super::super::run_tool(
        &mut specification(temporary.path(), "limits"),
        &|| Ok(()),
        super::super::ToolProcessObserver::default(),
    )
    .unwrap();
    assert!(!result.status.success());
    assert!(temporary.path().join("memory-limit-observed").exists());
    assert_eq!(
        fs::metadata(temporary.path().join("bounded-output"))
            .unwrap()
            .len(),
        4 * 1024 * 1024
    );
    assert_eq!(result.process_tree_proof["process_tree_active"], "0");
}

#[test]
fn namespace_creator_thread_exit_kills_its_live_decoder() {
    let temporary = tempfile::tempdir().unwrap();
    let specification = specification(temporary.path(), "detached");
    let (child, group) = std::thread::spawn(move || {
        spawn_tool(&specification).unwrap_or_else(|failure| panic!("{}", failure.error.message))
    })
    .join()
    .unwrap();
    let ToolProcessGroup::Decoder(namespace) = &group else {
        panic!("decoder namespace required")
    };
    let status = namespace.join(Duration::from_secs(5)).unwrap();
    assert_eq!(status.signal(), Some(libc::SIGKILL));
    assert!(group.proves_tree_quiescence());
    drop(child);
}

#[test]
fn namespace_parent_process_death_stops_detached_descendants() {
    let temporary = tempfile::tempdir().unwrap();
    let mut controller = Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "tool_process::linux::tests::namespace_fixture_child",
            "--ignored",
            "--nocapture",
        ])
        .env("PORTCOVE_NAMESPACE_FIXTURE_ROOT", temporary.path())
        .env("PORTCOVE_NAMESPACE_FIXTURE_MODE", "controller")
        .spawn()
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    while !temporary.path().join("controller-ready").exists()
        || !temporary.path().join("descendant-ready").exists()
    {
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(10));
    }
    let pid = fs::read_to_string(temporary.path().join("descendant-ready"))
        .unwrap()
        .trim()
        .parse::<i32>()
        .unwrap();
    let descriptor = unsafe { libc::syscall(libc::SYS_pidfd_open, pid, 0) };
    assert!(descriptor >= 0);
    let descriptor = unsafe { OwnedFd::from_raw_fd(descriptor as RawFd) };
    controller.kill().unwrap();
    controller.wait().unwrap();
    let mut observed = libc::pollfd {
        fd: descriptor.as_raw_fd(),
        events: libc::POLLIN,
        revents: 0,
    };
    assert_eq!(unsafe { libc::poll(&mut observed, 1, 5000) }, 1);
    assert_ne!(observed.revents & libc::POLLIN, 0);
    let bytes = fs::read(temporary.path().join("descendant-writes")).unwrap();
    std::thread::sleep(Duration::from_millis(50));
    assert_eq!(
        fs::read(temporary.path().join("descendant-writes")).unwrap(),
        bytes
    );
}

#[test]
fn namespace_closed_stdio_inherited_descriptors_and_signals_are_isolated() {
    let temporary = tempfile::tempdir().unwrap();
    let status = Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "tool_process::linux::tests::namespace_fixture_child",
            "--ignored",
            "--nocapture",
        ])
        .env("PORTCOVE_NAMESPACE_FIXTURE_ROOT", temporary.path())
        .env("PORTCOVE_NAMESPACE_FIXTURE_MODE", "closed-stdio")
        .status()
        .unwrap();
    assert!(status.success());
    assert!(temporary.path().join("closed-stdio-passed").exists());
}

#[test]
fn namespace_exec_failure_is_joined_before_spawn_failure_returns() {
    let temporary = tempfile::tempdir().unwrap();
    let invalid = temporary.path().join("invalid-executable");
    fs::write(&invalid, b"invalid executable format").unwrap();
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(&invalid, fs::Permissions::from_mode(0o700)).unwrap();
    let mut launch =
        ChildProcessPolicy::native_tool_spec(ChildProcessClass::HostTool, invalid).unwrap();
    launch.decoder_limits = specification(temporary.path(), "normal").decoder_limits;
    let failure = spawn_tool(&launch).err().expect("invalid exec must fail");
    assert!(failure.quiesced);
    assert!(failure.error.message.contains("13"));
}

#[test]
fn namespace_mapping_and_working_directory_failures_are_joined() {
    let temporary = tempfile::tempdir().unwrap();
    for phase in [4, 6, 10] {
        let mut prepared =
            PreparedExecution::new(&specification(temporary.path(), "normal")).unwrap();
        match phase {
            4 => prepared.uid_mapping = b"invalid mapping\n".to_vec(),
            6 => prepared.gid_mapping = b"invalid mapping\n".to_vec(),
            10 => {
                prepared.directory = Some(
                    CString::new(temporary.path().join("missing").as_os_str().as_bytes()).unwrap(),
                )
            }
            _ => unreachable!(),
        }
        let failure = spawn_prepared(prepared)
            .err()
            .expect("child setup must fail");
        assert!(failure.quiesced);
        assert!(
            failure.error.message.contains(&format!("phase {phase}")),
            "{}",
            failure.error.message
        );
    }
}

#[test]
fn namespace_unavailable_kernel_capability_has_no_process_group_fallback() {
    let temporary = tempfile::tempdir().unwrap();
    let status = Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "tool_process::linux::tests::namespace_fixture_child",
            "--ignored",
            "--nocapture",
        ])
        .env("PORTCOVE_NAMESPACE_FIXTURE_ROOT", temporary.path())
        .env("PORTCOVE_NAMESPACE_FIXTURE_MODE", "unsupported-clone")
        .status()
        .unwrap();
    assert!(status.success());
}

#[test]
fn namespace_withheld_start_cannot_execute_and_times_out_with_positive_join() {
    let temporary = tempfile::tempdir().unwrap();
    let prepared = PreparedExecution::new(&specification(temporary.path(), "normal")).unwrap();
    let failure = spawn_prepared_with_start(prepared, |errors, _start| {
        let deadline = Instant::now() + Duration::from_secs(7);
        assert_eq!(
            read_packet(errors.as_raw_fd(), deadline).unwrap(),
            Some([0, 0])
        );
        let failure = read_packet(errors.as_raw_fd(), deadline)
            .unwrap()
            .expect("withheld start must time out");
        assert_eq!(failure[0], 11);
        Err(io::Error::other("owned withheld-start control"))
    })
    .err()
    .expect("no start acknowledgement");
    assert!(failure.quiesced);
    assert!(
        !temporary
            .path()
            .join("admitted-executable-started")
            .exists()
    );
}

#[test]
fn unexpected_reaping_cannot_admit_or_signal_a_reused_numeric_identity() {
    let temporary = tempfile::tempdir().unwrap();
    let (_, group) = spawn_tool(&specification(temporary.path(), "normal"))
        .unwrap_or_else(|failure| panic!("{}", failure.error.message));
    let ToolProcessGroup::Decoder(namespace) = &group else {
        panic!("decoder namespace required")
    };
    let deadline = Instant::now() + Duration::from_secs(5);
    while !namespace.terminal().unwrap() {
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(10));
    }
    let mut information: libc::siginfo_t = unsafe { std::mem::zeroed() };
    assert_eq!(
        unsafe {
            libc::waitid(
                libc::P_PIDFD,
                namespace.pidfd.as_raw_fd() as libc::id_t,
                &mut information,
                libc::WEXITED,
            )
        },
        0
    );
    assert_eq!(
        namespace.observe().unwrap_err().raw_os_error(),
        Some(libc::ECHILD)
    );
    assert!(!group.proves_tree_quiescence());
    // No numeric PID is signalled, even after ownership of the wait was lost.
    namespace.signal().unwrap();
    assert!(!group.proves_tree_quiescence());
}
