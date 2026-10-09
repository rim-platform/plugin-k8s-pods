// The Pods panel. The plugin process sends its state through the host
// (panel.state_update); the panel runs the plugin's commands through the host
// bridge (rim.command.execute) and shows each answer (rim.command.result).
// Restarting asks the user first: the host shows the confirmation, never the panel.
(function () {
  "use strict";

  var PLUGIN_ID = "chat.rim.k8s-pods";
  var FILTER_DELAY_MS = 300;

  var state = null;
  var everHadState = false;
  var selected = 0;
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

  function restart(pod) {
    if (!pod || !state) return;
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

  function statusClass(status) {
    if (status === "Running" || status === "Completed" || status === "Succeeded") {
      return "status-ok";
    }
    if (status === "Pending" || status === "ContainerCreating" || status.indexOf("Init:") === 0) {
      return "status-warn";
    }
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

  function render() {
    if (!state) {
      // The plugin stopped (or has not sent anything yet): nothing to show or run.
      els.table.hidden = true;
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
    if (selected >= pods.length) selected = Math.max(0, pods.length - 1);

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
    els.interval.value = String(state.intervalSeconds);
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
    pods.forEach(function (pod, index) {
      var row = document.createElement("tr");
      if (index === selected) row.className = "selected";
      row.addEventListener("click", function () {
        selected = index;
        render();
      });
      cell(row, pod.name, "name");
      cell(row, pod.status, statusClass(pod.status));
      cell(row, pod.ready);
      cell(row, String(pod.restarts), "num");
      cell(row, age(pod), "num");
      cell(row, pod.node || "");
      var actions = cell(row, "");
      var button = document.createElement("button");
      button.type = "button";
      button.className = "danger";
      button.textContent = "Restart";
      button.title = "Restart " + pod.name + " (asks to confirm)";
      button.addEventListener("click", function (event) {
        event.stopPropagation();
        restart(pod);
      });
      actions.appendChild(button);
      els.rows.appendChild(row);
    });

    els.table.hidden = pods.length === 0;
    els.empty.hidden = pods.length > 0 || !!state.error;
    if (pods.length === 0) {
      els.empty.textContent = state.fetchedAt
        ? state.filter
          ? "No pods match “" + state.filter + "”."
          : "No pods in " + state.namespace + "."
        : "Loading pods…";
    }
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
    var pods = (state && state.pods) || [];
    switch (event.key) {
      case "j":
      case "ArrowDown":
        selected = Math.min(selected + 1, pods.length - 1);
        break;
      case "k":
      case "ArrowUp":
        selected = Math.max(selected - 1, 0);
        break;
      case "r":
        refresh();
        break;
      case "/":
        els.filter.focus();
        break;
      case "x":
        restart(pods[selected]);
        break;
      default:
        return;
    }
    event.preventDefault();
    render();
  });
})();
