// Line icons (24px grid, 2px stroke), built with createElementNS.

const PATHS = {
  menu: ["M4 6h16", "M4 12h16", "M4 18h16"],
  close: ["M6 6l12 12", "M18 6L6 18"],
  home: ["M3 10.5L12 3l9 7.5", "M5 9.5V21h5v-6h4v6h5V9.5"],
  bot: ["M12 4v3", "M5 8h14a1 1 0 0 1 1 1v9a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V9a1 1 0 0 1 1-1z", "M9 13v1", "M15 13v1", "M2 13h2", "M20 13h2"],
  edit: ["M4 20h4L19 9l-4-4L4 16v4z", "M13.5 6.5l4 4"],
  rocket: ["M5 15c-1.5 1.5-2 5-2 5s3.5-.5 5-2", "M9 15l-3-3c1-3.5 4.5-8 12-9-1 7.5-5.5 11-9 12z", "M14.5 9.5h.01"],
  send: ["M22 2L11 13", "M22 2l-7 20-4-9-9-4 20-7z"],
  users: ["M16 20v-1a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v1", "M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z", "M22 20v-1a4 4 0 0 0-3-3.9", "M16 3.1a4 4 0 0 1 0 7.8"],
  logout: ["M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3", "M10 17l-5-5 5-5", "M5 12h11"],
  chat: ["M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z"],
  trend: ["M3 17l6-6 4 4 8-8", "M15 7h6v6"],
  eye: ["M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z", "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z"],
  globe: ["M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z", "M2 12h20", "M12 2a15 15 0 0 1 0 20", "M12 2a15 15 0 0 0 0 20"],
  upload: ["M12 16V4", "M7 9l5-5 5 5", "M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3"],
  plus: ["M12 5v14", "M5 12h14"],
  arrow: ["M5 12h14", "M13 6l6 6-6 6"],
  check: ["M5 12.5l4.5 4.5L19 7.5"],
  spark: ["M12 3l1.8 4.7L18.5 9.5l-4.7 1.8L12 16l-1.8-4.7L5.5 9.5l4.7-1.8z", "M19 15l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z"],
  shield: ["M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6l8-3z", "M9 12l2 2 4-4"],
  external: ["M14 4h6v6", "M20 4l-9 9", "M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"],
};

export function icon(name, size = 20) {
  const NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("class", "ico");
  for (const d of PATHS[name] || []) {
    const p = document.createElementNS(NS, "path");
    p.setAttribute("d", d);
    svg.append(p);
  }
  return svg;
}
