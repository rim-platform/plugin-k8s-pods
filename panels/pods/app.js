// The Pods panel. The plugin process sends its state through the host
// (panel.state_update); the panel runs the plugin's commands through the host
// bridge (rim.command.execute) and shows each answer (rim.command.result).
// Restarting asks the user first: the host shows the confirmation, never the panel.
// A pod's logs open in a view over the list; the plugin streams followed lines
// into the state.
(function () {
  "use strict";

  var PLUGIN_ID = "chat.rim.k8s-pods";
  var FILTER_DELAY_MS = 300;

  var state = null;
  var everHadState = false;
  /** The selected pod's name, so a refresh that reorders the list keeps it. */
  var selectedName = null;
  var nextRequest = 1;
  var pending = {};
  var filterTimer = null;

  var $ = function (id) {
    return document.getElementById(id);
  };
  var els = {
    context: $("context"),
    namespace: $("namespace"),
    namespaceInput: $("namespace-input"),
    filter: $("filter"),
    interval: $("interval"),
    updated: $("updated"),
    refresh: $("refresh"),
    action: $("action"),
    error: $("error"),
    table: $("table"),
    rows: $("rows"),
    empty: $("empty"),
    footer: $("footer"),
    logs: $("logs"),
    logsTitle: $("logs-title"),
    logsContainer: $("logs-container"),
    logsLines: $("logs-lines"),
    logsPrevious: $("logs-previous"),
    logsFollow: $("logs-follow"),
    logsReload: $("logs-reload"),
    logsClose: $("logs-close"),
    logsStatus: $("logs-status"),
    logsText: $("logs-text"),
  };

  function send(message) {
    window.parent.postMessage(message, "*");
  }

  /** Run one of this plugin's commands; `onResult` gets the host's answer. */
  function run(verb, args, onResult) {
    var requestId = "pods-" + nextRequest++;
    if (onResult) pending[requestId] = onResult;
    send({
      type: "rim.command.execute",
      commandId: "plugin." + PLUGIN_ID + "." + verb,
      args: args || {},
      requestId: requestId,
    });
  }

  function notify(title, body) {
    send({ type: "rim.ui.notification.show", title: title, body: body });
  }

  /** Why the pod cannot be restarted from here, or `null` when it can. */
  function restartBlocked(pod) {
    if (!pod.controller)
      return "No controller would start it again, so restarting would delete it.";
    if (pod.controller.indexOf("Node/") === 0) {
      return "A static pod: the kubelet runs it from a file on its node. Restart it there.";
    }
    return null;
  }

  function restart(pod) {
    if (!pod || !state) return;
    var blocked = restartBlocked(pod);
    if (blocked) {
      notify("Cannot restart " + pod.name, blocked);
      return;
    }
    run(
      "restart_pod",
      { pod: pod.name, namespace: state.namespace, context: state.context },
      function (result) {
        if (result.cancelled) return;
        notify(result.ok ? "Pod restarted" : "Restart failed", result.message);
      },
    );
  }

  function refresh() {
    run("refresh", {});
  }

  /** Open or reload the log view; `changes` override the open view's choices. */
  function showLogs(pod, changes) {
    if (!state || !pod) return;
    var open = state.logs && state.logs.pod === pod ? state.logs : null;
    var args = {
      pod: pod,
      namespace: open ? open.namespace : state.namespace,
      context: open ? open.context : state.context,
      tail_lines: open ? open.tailLines : state.logTailLines,
      previous: open ? open.previous : false,
      follow: open ? open.following || !!changes.follow : true,
    };
    if (open && open.container) args.container = open.container;
    Object.keys(changes).forEach(function (key) {
      args[key] = changes[key];
    });
    if (args.previous) args.follow = false;
    run("pod_logs", args);
  }

  function stopLogs(close) {
    run("stop_logs", close ? { close: true } : {});
  }

  window.addEventListener("message", function (event) {
    if (event.source !== window.parent) return;
    var message = event.data;
    if (!message || typeof message.type !== "string") return;
    switch (message.type) {
      case "theme.changed":
        Object.keys(message.variables || {}).forEach(function (name) {
          var value = message.variables[name];
          if (value) document.documentElement.style.setProperty(name, value);
        });
        break;
      case "panel.state_update":
        state = message.state;
        render();
        break;
      case "rim.command.result": {
        var done = pending[message.requestId];
        delete pending[message.requestId];
        if (done) done(message);
        break;
      }
    }
  });

  // ── Rendering: textContent only, nothing from the cluster becomes HTML ──

  function setOptions(select, values, current) {
    var same =
      select.options.length === values.length &&
      values.every(function (v, i) {
        return select.options[i].value === v;
      });
    if (!same) {
      select.textContent = "";
      values.forEach(function (v) {
        var option = document.createElement("option");
        option.value = v;
        option.textContent = v;
        select.appendChild(option);
      });
    }
    if (current !== null && current !== undefined) select.value = current;
  }

  var SETTLING = [
    "Pending",
    "ContainerCreating",
    "PodInitializing",
    "Terminating",
    "SchedulingGated",
    "NotReady",
  ];

  function statusClass(status) {
    if (status === "Running" || status === "Completed" || status === "Succeeded") {
      return "status-ok";
    }
    // Init:1/3 is progress; Init:CrashLoopBackOff and the like are failures.
    if (SETTLING.indexOf(status) >= 0 || /^Init:\d+\/\d+$/.test(status)) return "status-warn";
    return "status-bad";
  }

  function age(pod) {
    if (!pod.createdAt) return pod.age || "";
    var seconds = Math.max(0, Math.floor((Date.now() - Date.parse(pod.createdAt)) / 1000));
    if (seconds < 120) return seconds + "s";
    var minutes = Math.floor(seconds / 60);
    if (minutes < 120) return minutes + "m";
    var hours = Math.floor(minutes / 60);
    if (hours < 48) return hours + "h";
    var days = Math.floor(hours / 24);
    return days < 730 ? days + "d" : Math.floor(days / 365) + "y";
  }

  function cell(row, text, className) {
    var td = document.createElement("td");
    td.textContent = text;
    if (className) td.className = className;
    row.appendChild(td);
    return td;
  }

  function selectedIndex(pods) {
    for (var i = 0; i < pods.length; i++) if (pods[i].name === selectedName) return i;
    return -1;
  }

  function render() {
    if (!state) {
      // The plugin stopped (or has not sent anything yet): nothing to show or run.
      els.table.hidden = true;
      els.logs.hidden = true;
      els.footer.hidden = false;
      els.action.hidden = true;
      els.error.hidden = true;
      els.refresh.disabled = true;
      els.updated.textContent = "";
      els.empty.hidden = false;
      els.empty.textContent = everHadState
        ? "The Kubernetes Pods plugin is not running. Turn it on in Settings → Plugins."
        : "Loading pods…";
      return;
    }
    everHadState = true;
    var pods = state.pods || [];
    if (selectedIndex(pods) < 0) selectedName = pods.length > 0 ? pods[0].name : null;

    setOptions(els.context, state.contexts || [], state.context);
    var listed = Array.isArray(state.namespaces);
    els.namespace.hidden = !listed;
    els.namespaceInput.hidden = listed;
    if (listed) {
      var namespaces = state.namespaces.slice();
      if (state.namespace && namespaces.indexOf(state.namespace) < 0) {
        namespaces.unshift(state.namespace);
      }
      setOptions(els.namespace, namespaces, state.namespace);
    } else if (document.activeElement !== els.namespaceInput) {
      els.namespaceInput.value = state.namespace || "";
    }
    if (document.activeElement !== els.filter) els.filter.value = state.filter || "";
    var interval = String(state.intervalSeconds);
    if (!els.interval.querySelector('option[value="' + interval + '"]')) {
      var option = document.createElement("option");
      option.value = interval;
      option.textContent = interval + "s";
      els.interval.appendChild(option);
    }
    els.interval.value = interval;
    els.refresh.disabled = !!state.loading;
    renderUpdated();

    els.error.hidden = !state.error;
    els.error.textContent = "";
    if (state.error) {
      var message = document.createElement("div");
      message.textContent = state.error.message;
      els.error.appendChild(message);
      if (state.error.detail && state.error.message.indexOf(state.error.detail) < 0) {
        var detail = document.createElement("div");
        detail.className = "detail";
        detail.textContent = "kubectl: " + state.error.detail;
        els.error.appendChild(detail);
      }
    }

    var last = state.lastAction;
    els.action.hidden = !last;
    if (last) {
      els.action.className = "banner " + (last.ok ? "ok" : "error");
      els.action.textContent = last.message;
    }

    els.rows.textContent = "";
    pods.forEach(function (pod) {
      var row = document.createElement("tr");
      if (pod.name === selectedName) row.className = "selected";
      row.addEventListener("click", function () {
        selectedName = pod.name;
        render();
      });
      cell(row, pod.name, "name");
      cell(row, pod.status, statusClass(pod.status));
      cell(row, pod.ready);
      cell(row, String(pod.restarts), "num");
      cell(row, age(pod), "num");
      cell(row, pod.node || "");
      var actions = cell(row, "", "actions");
      var logs = document.createElement("button");
      logs.type = "button";
      logs.textContent = "Logs";
      logs.title = "Show and follow the logs of " + pod.name + " (l)";
      logs.addEventListener("click", function (event) {
        event.stopPropagation();
        selectedName = pod.name;
        showLogs(pod.name, {});
      });
      actions.appendChild(logs);
      var button = document.createElement("button");
      button.type = "button";
      button.className = "danger";
      button.textContent = "Restart";
      var blocked = restartBlocked(pod);
      button.disabled = !!blocked;
      button.title = blocked || "Restart " + pod.name + " (asks to confirm)";
      button.addEventListener("click", function (event) {
        event.stopPropagation();
        restart(pod);
      });
      actions.appendChild(button);
      els.rows.appendChild(row);
    });

    var viewing = !!state.logs;
    els.logs.hidden = !viewing;
    els.footer.hidden = viewing;
    if (viewing) renderLogs(state.logs);

    els.table.hidden = viewing || pods.length === 0;
    els.empty.hidden = viewing || pods.length > 0 || !!state.error;
    if (pods.length === 0) {
      els.empty.textContent = state.fetchedAt
        ? state.filter
          ? "No pods match “" + state.filter + "”."
          : "No pods in " + state.namespace + "."
        : "Loading pods…";
    }
  }

  function renderLogs(logs) {
    els.logsTitle.textContent = logs.pod;
    setOptions(
      els.logsContainer,
      logs.containers.length ? logs.containers : [logs.container],
      logs.container,
    );
    els.logsContainer.disabled = logs.containers.length < 2;
    var lines = String(logs.tailLines);
    if (!els.logsLines.querySelector('option[value="' + lines + '"]')) {
      var option = document.createElement("option");
      option.value = lines;
      option.textContent = lines;
      els.logsLines.appendChild(option);
    }
    els.logsLines.value = lines;
    els.logsPrevious.checked = logs.previous;
    els.logsFollow.checked = logs.following;
    els.logsFollow.disabled = logs.previous;

    var status = logs.error
      ? logs.error.message
      : logs.loading
        ? "Loading logs…"
        : logs.ended
          ? logs.ended
          : logs.following
            ? "Following new lines…"
            : logs.lines.length + " lines";
    if (!logs.error && logs.dropped > 0) {
      status += " · older lines dropped, the last " + logs.lines.length + " are kept";
    }
    els.logsStatus.textContent = status;
    els.logsStatus.className = logs.error ? "status-bad" : "";

    // Stay at the bottom while following, unless the user scrolled up to read.
    var text = els.logsText;
    var atBottom = text.scrollTop + text.clientHeight >= text.scrollHeight - 4;
    var body = logs.lines.join("\n");
    if (text.textContent !== body) text.textContent = body;
    if (atBottom) text.scrollTop = text.scrollHeight;
  }

  function renderUpdated() {
    if (!state) return;
    if (state.loading) {
      els.updated.textContent = "Refreshing…";
    } else if (state.fetchedAt) {
      var seconds = Math.max(0, Math.round((Date.now() - Date.parse(state.fetchedAt)) / 1000));
      var shown = state.filter ? state.pods.length + " of " + state.totalPods : state.totalPods;
      els.updated.textContent = shown + " pods · updated " + seconds + "s ago";
    } else {
      els.updated.textContent = "";
    }
  }

  // Ages and "updated" stay current between listings.
  setInterval(function () {
    if (!state) return;
    var cells = els.rows.querySelectorAll("tr");
    (state.pods || []).forEach(function (pod, i) {
      if (cells[i]) cells[i].children[4].textContent = age(pod);
    });
    renderUpdated();
  }, 5000);

  // ── Input ──

  els.refresh.addEventListener("click", refresh);
  els.logsClose.addEventListener("click", function () {
    stopLogs(true);
  });
  els.logsReload.addEventListener("click", function () {
    if (state && state.logs) showLogs(state.logs.pod, {});
  });
  els.logsFollow.addEventListener("change", function () {
    if (!state || !state.logs) return;
    if (els.logsFollow.checked) showLogs(state.logs.pod, { follow: true });
    else stopLogs(false);
  });
  els.logsPrevious.addEventListener("change", function () {
    if (state && state.logs) showLogs(state.logs.pod, { previous: els.logsPrevious.checked });
  });
  els.logsContainer.addEventListener("change", function () {
    if (state && state.logs) showLogs(state.logs.pod, { container: els.logsContainer.value });
  });
  els.logsLines.addEventListener("change", function () {
    if (state && state.logs) {
      showLogs(state.logs.pod, { tail_lines: Number(els.logsLines.value) });
    }
  });
  els.context.addEventListener("change", function () {
    run("filter", { context: els.context.value });
  });
  els.namespace.addEventListener("change", function () {
    run("filter", { namespace: els.namespace.value });
  });
  els.namespaceInput.addEventListener("change", function () {
    var value = els.namespaceInput.value.trim();
    if (value) run("filter", { namespace: value });
  });
  els.interval.addEventListener("change", function () {
    run("filter", { interval_seconds: Number(els.interval.value) });
  });
  els.filter.addEventListener("input", function () {
    clearTimeout(filterTimer);
    filterTimer = setTimeout(function () {
      run("filter", { text: els.filter.value });
    }, FILTER_DELAY_MS);
  });

  document.addEventListener("keydown", function (event) {
    var target = event.target;
    var typing = target && (target.tagName === "INPUT" || target.tagName === "SELECT");
    if (typing) {
      if (event.key === "Escape" || event.key === "Enter") target.blur();
      return;
    }
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (state && state.logs) {
      logKey(event);
      return;
    }
    var pods = (state && state.pods) || [];
    var index = selectedIndex(pods);
    switch (event.key) {
      case "j":
      case "ArrowDown":
        if (pods.length) selectedName = pods[Math.min(index + 1, pods.length - 1)].name;
        break;
      case "k":
      case "ArrowUp":
        if (pods.length) selectedName = pods[Math.max(index - 1, 0)].name;
        break;
      case "l":
        if (index >= 0) showLogs(pods[index].name, {});
        break;
      case "r":
        refresh();
        break;
      case "/":
        els.filter.focus();
        break;
      case "x":
        restart(pods[index]);
        break;
      default:
        return;
    }
    event.preventDefault();
    render();
    var row = els.rows.querySelector("tr.selected");
    if (row && row.scrollIntoView) row.scrollIntoView({ block: "nearest" });
  });

  function logKey(event) {
    var logs = state.logs;
    switch (event.key) {
      case "Escape":
        stopLogs(true);
        break;
      case "f":
        if (logs.following) stopLogs(false);
        else if (!logs.previous) showLogs(logs.pod, { follow: true });
        break;
      case "p":
        showLogs(logs.pod, { previous: !logs.previous });
        break;
      case "r":
        showLogs(logs.pod, {});
        break;
      default:
        return;
    }
    event.preventDefault();
  }
})();
