const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"];
const START_HOUR = 8;
const END_HOUR = 22;
const MINUTES_PER_HOUR = 60;
const STORAGE_KEY = "campus-week-planner-v1";
const USC_PROGRAMS_ENDPOINT = "/api/usc/programs";
const USC_PROGRAM_ENDPOINT = "/api/usc/program";
const DEFAULT_COLOR = "#ef9da4";
const STUDY_COLOR = "#afe9a0";
const PLAN_FILE_VERSION = 1;
const SCREEN_HOUR_HEIGHT = 72;
const PRINT_HOUR_HEIGHT = 42;
const ITEM_TYPES = new Set(["Lecture", "Lab", "Seminar", "Study", "Work", "Personal"]);
const HEX_COLOR_PATTERN = /^#[0-9a-f]{6}$/i;
const DAY_ALIASES = {
  Mon: "Monday",
  Tue: "Tuesday",
  Wed: "Wednesday",
  Thu: "Thursday",
  Fri: "Friday",
};

const state = {
  items: loadItems(),
  selectedProgram: null,
  selectedProgramData: null,
  printMode: false,
};

let uscPrograms = [...(window.USC_PROGRAMS || [])];

const elements = {
  form: document.querySelector("#scheduleForm"),
  editingId: document.querySelector("#editingId"),
  program: document.querySelector("#programInput"),
  course: document.querySelector("#courseInput"),
  section: document.querySelector("#sectionInput"),
  addSection: document.querySelector("#addSectionButton"),
  courseCount: document.querySelector("#courseCountLabel"),
  title: document.querySelector("#titleInput"),
  type: document.querySelector("#typeInput"),
  start: document.querySelector("#startInput"),
  end: document.querySelector("#endInput"),
  location: document.querySelector("#locationInput"),
  formMessage: document.querySelector("#formMessage"),
  submit: document.querySelector("#submitButton"),
  cancelEdit: document.querySelector("#cancelEditButton"),
  calendar: document.querySelector("#calendarGrid"),
  template: document.querySelector("#itemTemplate"),
  status: document.querySelector("#statusList"),
  summary: document.querySelector("#scheduleSummary"),
  studyLength: document.querySelector("#studyLengthInput"),
  autoStudy: document.querySelector("#autoStudyButton"),
  clear: document.querySelector("#clearButton"),
  sample: document.querySelector("#loadSampleButton"),
  print: document.querySelector("#printButton"),
  savePlan: document.querySelector("#savePlanButton"),
  loadPlan: document.querySelector("#loadPlanButton"),
  loadPlanInput: document.querySelector("#loadPlanInput"),
  exportPng: document.querySelector("#exportPngButton"),
};

function loadItems() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    return Array.isArray(saved) ? saved : [];
  } catch {
    return [];
  }
}

function saveItems() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state.items));
}

function toMinutes(value) {
  const [hours, minutes] = value.split(":").map(Number);
  return hours * MINUTES_PER_HOUR + minutes;
}

function toScheduleMinutes(value) {
  const minutes = toMinutes(value);
  const afternoonMinutes = minutes + 12 * MINUTES_PER_HOUR;

  if (minutes < START_HOUR * MINUTES_PER_HOUR && afternoonMinutes <= END_HOUR * MINUTES_PER_HOUR) {
    return afternoonMinutes;
  }

  return minutes;
}

function toScheduleRange(startValue, endValue) {
  const start = toScheduleMinutes(startValue);
  let end = toMinutes(endValue);
  const afternoonEnd = end + 12 * MINUTES_PER_HOUR;

  if ((end < START_HOUR * MINUTES_PER_HOUR || end <= start) && afternoonEnd <= END_HOUR * MINUTES_PER_HOUR) {
    end = afternoonEnd;
  }

  return { start, end };
}

function toClock(minutes) {
  const date = new Date(2000, 0, 1, 0, minutes);
  return date.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
  });
}

function createId() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  return `id-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function formatRange(start, end) {
  return `${toClock(start)}-${toClock(end)}`;
}

function splitScheduleTitle(title) {
  const match = title.match(/^([A-Z]{2,5}\s+\d+[A-Z]*[a-z]*)(?:\s+-\s+(.+))?$/);

  if (!match) {
    return { code: title, name: "" };
  }

  return {
    code: match[1],
    name: match[2] || "",
  };
}

function getSelectedDays() {
  return [...document.querySelectorAll('input[name="days"]:checked')].map((input) => input.value);
}

function getSelectedColor() {
  return document.querySelector('input[name="color"]:checked').value;
}

function setSelectedColor(color) {
  const target = document.querySelector(`input[name="color"][value="${color}"]`);
  if (target) target.checked = true;
}

function setSelectedDays(days) {
  document.querySelectorAll('input[name="days"]').forEach((input) => {
    input.checked = days.includes(input.value);
  });
}

function initializeCoursePicker() {
  const currentValue = elements.program.value;
  elements.program.innerHTML = '<option value="">Select a major</option>';

  uscPrograms.forEach((program) => {
    const option = document.createElement("option");
    option.value = program.key;
    option.textContent = `${program.programName} (${program.programPrefix}) · ${program.schoolName}`;
    elements.program.append(option);
  });

  if (currentValue && uscPrograms.some((program) => program.key === currentValue)) {
    elements.program.value = currentValue;
  }

  elements.courseCount.textContent = `${uscPrograms.length} USC Fall 2026 majors loaded.`;
}

async function refreshUscPrograms() {
  try {
    const response = await fetch(USC_PROGRAMS_ENDPOINT, { cache: "no-store" });
    if (!response.ok) throw new Error("Could not refresh USC majors.");
    const payload = await response.json();
    if (!Array.isArray(payload.programs)) throw new Error("Invalid USC majors response.");

    uscPrograms = payload.programs;
    initializeCoursePicker();
    elements.courseCount.textContent = `${uscPrograms.length} USC Fall 2026 majors updated from USC.`;
  } catch {
    elements.courseCount.textContent = `${uscPrograms.length} USC Fall 2026 majors loaded from the saved cache.`;
  }
}

async function loadSelectedProgram() {
  const program = uscPrograms.find((candidate) => candidate.key === elements.program.value);
  state.selectedProgram = program || null;
  state.selectedProgramData = null;
  resetUscCourseControls();

  if (!program) {
    elements.courseCount.textContent = `${uscPrograms.length} USC Fall 2026 majors loaded.`;
    return;
  }

  elements.course.disabled = true;
  elements.course.innerHTML = '<option value="">Loading courses...</option>';
  elements.courseCount.textContent = `Loading ${program.programName} courses.`;

  try {
    const response = await fetch(
      `${USC_PROGRAM_ENDPOINT}?school=${encodeURIComponent(program.schoolPrefix)}&program=${encodeURIComponent(program.programPrefix)}`,
      { cache: "no-store" },
    );
    if (!response.ok) throw new Error("Could not load program data.");
    state.selectedProgramData = await response.json();
    populateCourseSelect(state.selectedProgramData.courses || []);
    elements.courseCount.textContent = `${state.selectedProgramData.courses.length} ${program.programPrefix} courses with scheduled sections loaded.`;
  } catch {
    try {
      const response = await fetch(program.file, { cache: "no-store" });
      if (!response.ok) throw new Error("Could not load cached program data.");
      state.selectedProgramData = await response.json();
      populateCourseSelect(state.selectedProgramData.courses || []);
      elements.courseCount.textContent = `${state.selectedProgramData.courses.length} ${program.programPrefix} cached courses with scheduled sections loaded.`;
    } catch {
      elements.course.innerHTML = '<option value="">Could not load courses</option>';
      elements.course.disabled = true;
      elements.courseCount.textContent = "Could not load this major's course data.";
      addStatus("Could not load USC course data for the selected major.", "danger");
    }
  }
}

function resetUscCourseControls() {
  elements.course.innerHTML = '<option value="">Select a major first</option>';
  elements.course.disabled = true;
  elements.section.innerHTML = '<option value="">Select a course first</option>';
  elements.section.disabled = true;
  elements.addSection.disabled = true;
}

function populateCourseSelect(courses) {
  elements.course.innerHTML = '<option value="">Select a course</option>';

  courses.forEach((course) => {
    const option = document.createElement("option");
    option.value = String(course.id);
    option.textContent = `${course.code} - ${course.name}`;
    elements.course.append(option);
  });

  elements.course.disabled = courses.length === 0;
  elements.section.innerHTML = '<option value="">Select a course first</option>';
  elements.section.disabled = true;
  elements.addSection.disabled = true;
}

function populateSectionSelect() {
  const course = getSelectedUscCourse();
  elements.section.innerHTML = '<option value="">Select a section</option>';
  elements.addSection.disabled = true;

  if (!course) {
    elements.section.innerHTML = '<option value="">Select a course first</option>';
    elements.section.disabled = true;
    return;
  }

  course.sections.forEach((section) => {
    const option = document.createElement("option");
    option.value = section.id;
    option.textContent = sectionOptionLabel(course, section);
    elements.section.append(option);
  });

  elements.section.disabled = course.sections.length === 0;
}

function sectionOptionLabel(course, section) {
  const meetingText = section.schedule.map((meeting) => `${meeting.days.join("/")} ${formatInputTime(meeting.startTime)}-${formatInputTime(meeting.endTime)}`).join("; ");
  const instructorText = section.instructors.length ? ` · ${section.instructors.join(", ")}` : "";
  const statusText = section.isCancelled ? " · Cancelled" : section.isFull ? " · Full" : "";
  const clearanceText = section.hasDClearance ? " · D-clearance" : "";
  return `${course.code} · ${section.mode} ${section.id} · ${meetingText}${instructorText}${statusText}${clearanceText}`;
}

function getSelectedUscCourse() {
  const courseId = Number(elements.course.value);
  if (!state.selectedProgramData || !courseId) return null;
  return state.selectedProgramData.courses.find((course) => Number(course.id) === courseId) || null;
}

function getSelectedUscSection() {
  const course = getSelectedUscCourse();
  if (!course) return { course: null, section: null };
  return {
    course,
    section: course.sections.find((section) => section.id === elements.section.value) || null,
  };
}

function previewSelectedUscSection() {
  const { course, section } = getSelectedUscSection();
  elements.addSection.disabled = !course || !section;
  if (!course || !section) return;

  const firstMeeting = section.schedule[0];
  const weekdays = firstMeeting.days.map((day) => DAY_ALIASES[day]).filter(Boolean);
  elements.title.value = course.title;
  elements.type.value = sectionType(section.mode);
  elements.start.value = firstMeeting.startTime;
  elements.end.value = firstMeeting.endTime;
  elements.location.value = sectionLocation(section);
  setSelectedDays(weekdays.length ? weekdays : ["Monday"]);
}

function addSelectedUscSection() {
  const { course, section } = getSelectedUscSection();
  if (!course || !section) {
    showFormMessage("Select a USC section first.", "danger");
    return;
  }

  const meetings = section.schedule
    .flatMap((meeting) =>
      meeting.days.map((day) => ({
        day: DAY_ALIASES[day],
        start: toMinutes(meeting.startTime),
        end: toMinutes(meeting.endTime),
      })),
    )
    .filter((meeting) => meeting.day && meeting.start >= START_HOUR * MINUTES_PER_HOUR && meeting.end <= END_HOUR * MINUTES_PER_HOUR);

  if (meetings.length === 0) {
    showFormMessage("This section has no Monday-Friday meeting between 8:00 AM and 10:00 PM.", "danger");
    return;
  }

  const groupId = createId();
  const color = getSelectedColor();
  const type = sectionType(section.mode);
  const location = sectionLocation(section);
  const newItems = meetings.map((meeting) => ({
    id: createId(),
    groupId,
    title: course.title,
    type,
    day: meeting.day,
    start: meeting.start,
    end: meeting.end,
    location,
    color,
    autoGenerated: false,
  }));

  state.items.push(...newItems);
  render();
  showFormMessage(`Added ${course.code} section ${section.id}.`, "info");
  addStatus(`Added ${course.code} section ${section.id} to the timetable.`);
  scrollToScheduleOnSmallScreens();
}

function sectionType(mode) {
  const normalized = String(mode || "").toLowerCase();
  if (normalized.includes("lecture")) return "Lecture";
  if (normalized.includes("lab")) return "Lab";
  if (normalized.includes("seminar") || normalized.includes("discussion") || normalized.includes("quiz")) return "Seminar";
  return "Lecture";
}

function sectionLocation(section) {
  const lastNames = section.instructors
    .map((name) => name.split(" ").filter(Boolean).at(-1))
    .filter(Boolean)
    .join(", ");
  return `Sec ${section.id}${lastNames ? ` · ${lastNames}` : ""}`;
}

function formatInputTime(value) {
  return toClock(toMinutes(value));
}

function buildCalendarShell() {
  elements.calendar.innerHTML = "";

  const timeHeader = document.createElement("div");
  timeHeader.className = "time-header";
  timeHeader.textContent = "Time";
  elements.calendar.append(timeHeader);

  DAYS.forEach((day) => {
    const header = document.createElement("div");
    header.className = "day-header";
    header.textContent = day;
    elements.calendar.append(header);
  });

  const timeCell = document.createElement("div");
  timeCell.className = "time-cell";
  for (let hour = START_HOUR; hour < END_HOUR; hour += 1) {
    const label = document.createElement("div");
    label.className = "time-label";
    label.textContent = toClock(hour * MINUTES_PER_HOUR);
    timeCell.append(label);
  }
  elements.calendar.append(timeCell);

  DAYS.forEach((day) => {
    const column = document.createElement("div");
    column.className = "day-column";
    column.dataset.day = day;
    elements.calendar.append(column);
  });
}

function findConflicts(items) {
  const conflictIds = new Set();

  DAYS.forEach((day) => {
    const dayItems = items
      .filter((item) => item.day === day)
      .sort((a, b) => a.start - b.start);

    dayItems.forEach((item, index) => {
      for (let nextIndex = index + 1; nextIndex < dayItems.length; nextIndex += 1) {
        const next = dayItems[nextIndex];
        if (next.start >= item.end) break;
        conflictIds.add(item.id);
        conflictIds.add(next.id);
      }
    });
  });

  return conflictIds;
}

function render() {
  buildCalendarShell();

  const conflicts = findConflicts(state.items);
  state.items.forEach((item) => renderItem(item, conflicts.has(item.id)));
  renderStatus(conflicts);
  renderSummary(conflicts);
  saveItems();
}

function renderItem(item, hasConflict) {
  const column = elements.calendar.querySelector(`[data-day="${item.day}"]`);
  const node = elements.template.content.firstElementChild.cloneNode(true);
  const hourHeight = getCalendarHourHeight();
  const top = ((item.start - START_HOUR * MINUTES_PER_HOUR) / MINUTES_PER_HOUR) * hourHeight;
  const height = ((item.end - item.start) / MINUTES_PER_HOUR) * hourHeight;

  node.dataset.id = item.id;
  node.style.top = `${Math.max(0, top)}px`;
  node.style.height = `${Math.max(48, height - 6)}px`;
  node.style.setProperty("--item-color", item.color);
  node.classList.toggle("study", item.type === "Study");
  node.classList.toggle("conflict", hasConflict);
  renderItemTitle(node.querySelector(".item-title"), item.title);
  node.querySelector(".item-meta").textContent = `${item.type} · ${formatRange(item.start, item.end)}${item.location ? ` · ${item.location}` : ""}`;
  node.querySelector(".edit-button").addEventListener("click", () => startEditing(item.id));
  node.querySelector(".delete-button").addEventListener("click", () => deleteItem(item.id));
  column.append(node);
}

function getCalendarHourHeight() {
  return state.printMode ? PRINT_HOUR_HEIGHT : SCREEN_HOUR_HEIGHT;
}

function renderItemTitle(titleNode, title) {
  const { code, name } = splitScheduleTitle(title);
  titleNode.innerHTML = "";

  const codeNode = document.createElement("span");
  codeNode.className = "item-code";
  codeNode.textContent = code;
  titleNode.append(codeNode);

  if (name) {
    const nameNode = document.createElement("span");
    nameNode.className = "item-course-name";
    nameNode.textContent = name;
    titleNode.append(nameNode);
  }
}

function renderStatus(conflicts) {
  elements.status.innerHTML = "";

  if (state.items.length === 0) {
    addStatus("Add classes, work shifts, and study plans to begin.");
    return;
  }

  if (conflicts.size > 0) {
    addStatus(`${conflicts.size} item${conflicts.size === 1 ? "" : "s"} need conflict review.`, "danger");
  } else {
    addStatus("No time conflicts detected.");
  }

  const longestDay = getDayLoads().sort((a, b) => b.minutes - a.minutes)[0];
  if (longestDay?.minutes > 0) {
    addStatus(`${longestDay.day} is the busiest day at ${Math.round(longestDay.minutes / 60)} planned hours.`);
  }

  const lateItems = state.items.filter((item) => item.end > 18 * MINUTES_PER_HOUR);
  if (lateItems.length > 0) {
    addStatus(`${lateItems.length} item${lateItems.length === 1 ? "" : "s"} end after 6:00 PM.`, "warning");
  }
}

function addStatus(text, variant = "") {
  const pill = document.createElement("div");
  pill.className = `status-pill ${variant}`.trim();
  pill.textContent = text;
  elements.status.append(pill);
}

function showFormMessage(text, variant = "") {
  elements.formMessage.textContent = text;
  elements.formMessage.className = `form-message ${variant}`.trim();
  elements.formMessage.hidden = false;
}

function clearFormMessage() {
  elements.formMessage.textContent = "";
  elements.formMessage.hidden = true;
}

function renderSummary(conflicts) {
  const itemCount = state.items.length;
  const studyCount = state.items.filter((item) => item.type === "Study").length;
  const conflictCount = conflicts.size;

  if (itemCount === 0) {
    elements.summary.textContent = "No items yet.";
    return;
  }

  elements.summary.textContent = `${itemCount} item${itemCount === 1 ? "" : "s"} planned · ${studyCount} study block${studyCount === 1 ? "" : "s"} · ${conflictCount} conflict${conflictCount === 1 ? "" : "s"}`;
}

function getDayLoads() {
  return DAYS.map((day) => ({
    day,
    minutes: state.items
      .filter((item) => item.day === day)
      .reduce((total, item) => total + (item.end - item.start), 0),
  }));
}

function validateEntry({ days, start, end, title }) {
  if (!title.trim()) return "Title is required.";
  if (days.length === 0) return "Select at least one weekday.";
  if (end <= start) return "End time must be after start time.";
  if (start < START_HOUR * MINUTES_PER_HOUR || end > END_HOUR * MINUTES_PER_HOUR) {
    return "Items must stay between 8:00 AM and 10:00 PM.";
  }
  return "";
}

function handleSubmit(event) {
  event.preventDefault();
  clearFormMessage();

  const title = elements.title.value.trim();
  const type = elements.type.value;
  const days = getSelectedDays();
  const { start, end } = toScheduleRange(elements.start.value, elements.end.value);
  const location = elements.location.value.trim();
  const color = getSelectedColor();
  const editingId = elements.editingId.value;
  const validationMessage = validateEntry({ title, days, start, end });

  if (validationMessage) {
    showFormMessage(validationMessage);
    addStatus(validationMessage, "danger");
    return;
  }

  if (editingId) {
    state.items = state.items.filter((item) => item.groupId !== editingId && item.id !== editingId);
  }

  const groupId = editingId || createId();
  const newItems = days.map((day) => ({
    id: createId(),
    groupId,
    title,
    type,
    day,
    start,
    end,
    location,
    color,
    autoGenerated: false,
  }));

  state.items.push(...newItems);
  resetForm();
  render();
  showFormMessage("Item added to the timetable.", "info");
  scrollToScheduleOnSmallScreens();
}

function scrollToScheduleOnSmallScreens() {
  if (window.matchMedia("(max-width: 980px)").matches) {
    document.querySelector(".schedule-area").scrollIntoView({ block: "start", behavior: "smooth" });
  }
}

function startEditing(id) {
  const item = state.items.find((candidate) => candidate.id === id);
  if (!item) return;
  const related = state.items.filter((candidate) => candidate.groupId === item.groupId);

  elements.editingId.value = item.groupId;
  elements.title.value = item.title;
  elements.type.value = item.type;
  elements.start.value = minutesToInputValue(item.start);
  elements.end.value = minutesToInputValue(item.end);
  elements.location.value = item.location;
  setSelectedColor(item.color);
  setSelectedDays(related.map((candidate) => candidate.day));
  elements.submit.textContent = "Update Item";
  elements.cancelEdit.hidden = false;
  elements.title.focus();
}

function minutesToInputValue(minutes) {
  const hours = String(Math.floor(minutes / 60)).padStart(2, "0");
  const rest = String(minutes % 60).padStart(2, "0");
  return `${hours}:${rest}`;
}

function deleteItem(id) {
  const item = state.items.find((candidate) => candidate.id === id);
  if (!item) return;
  state.items = state.items.filter((candidate) => candidate.groupId !== item.groupId && candidate.id !== id);
  render();
}

function resetForm() {
  elements.form.reset();
  elements.editingId.value = "";
  clearFormMessage();
  elements.title.value = "";
  elements.type.value = "Lecture";
  elements.start.value = "09:00";
  elements.end.value = "10:15";
  setSelectedDays(["Monday"]);
  setSelectedColor(DEFAULT_COLOR);
  elements.submit.textContent = "Add Item";
  elements.cancelEdit.hidden = true;
}

function autoPlanStudyBlocks() {
  const length = Number(elements.studyLength.value);
  const courses = state.items.filter((item) => ["Lecture", "Lab", "Seminar"].includes(item.type));
  const uniqueCourses = [];
  const seenGroups = new Set();

  courses.forEach((course) => {
    if (!seenGroups.has(course.groupId)) {
      seenGroups.add(course.groupId);
      uniqueCourses.push(course);
    }
  });

  state.items = state.items.filter((item) => !item.autoGenerated);

  const created = [];
  uniqueCourses.forEach((course) => {
    const slot = findStudySlot(length);
    if (!slot) return;
    created.push({
      id: createId(),
      groupId: createId(),
      title: `Study: ${course.title}`,
      type: "Study",
      day: slot.day,
      start: slot.start,
      end: slot.start + length,
      location: "Library",
      color: STUDY_COLOR,
      autoGenerated: true,
    });
    state.items.push(created.at(-1));
  });

  render();
  addStatus(`Auto planned ${created.length} study block${created.length === 1 ? "" : "s"}.`);
}

function findStudySlot(length) {
  const dayOrder = getDayLoads().sort((a, b) => a.minutes - b.minutes).map((load) => load.day);
  const startLimit = 9 * MINUTES_PER_HOUR;
  const endLimit = 18 * MINUTES_PER_HOUR;

  for (const day of dayOrder) {
    for (let start = startLimit; start + length <= endLimit; start += 15) {
      const candidate = { day, start, end: start + length };
      if (!overlapsExisting(candidate)) return candidate;
    }
  }

  return null;
}

function overlapsExisting(candidate) {
  return state.items.some((item) => {
    if (item.day !== candidate.day) return false;
    return candidate.start < item.end && candidate.end > item.start;
  });
}

function loadSampleSchedule() {
  state.items = [
    makeItem("Calculus I", "Lecture", "Monday", "09:00", "10:15", "Math 110", "#9ecce8", "sample-calculus"),
    makeItem("Calculus I", "Lecture", "Wednesday", "09:00", "10:15", "Math 110", "#9ecce8", "sample-calculus"),
    makeItem("General Chemistry", "Lab", "Tuesday", "13:00", "15:30", "Science 214", "#efb99e", "sample-chemistry"),
    makeItem("World Literature", "Seminar", "Thursday", "10:30", "11:45", "Humanities 32", "#b39be8", "sample-literature"),
    makeItem("Campus Job", "Work", "Friday", "12:00", "16:00", "Student Center", "#e89ac3", "sample-job"),
  ];
  render();
}

function makeItem(title, type, day, start, end, location, color, groupId) {
  return {
    id: createId(),
    groupId,
    title,
    type,
    day,
    start: toMinutes(start),
    end: toMinutes(end),
    location,
    color,
    autoGenerated: false,
  };
}

function clearAll() {
  if (state.items.length === 0) return;
  const confirmed = window.confirm("Clear every schedule item?");
  if (!confirmed) return;
  state.items = [];
  resetForm();
  render();
}

function saveTimetableFile() {
  const data = {
    app: "Campus Week Planner",
    version: PLAN_FILE_VERSION,
    savedAt: new Date().toISOString(),
    range: {
      days: DAYS,
      startHour: START_HOUR,
      endHour: END_HOUR,
    },
    items: state.items
      .slice()
      .sort((a, b) => DAYS.indexOf(a.day) - DAYS.indexOf(b.day) || a.start - b.start),
  };

  downloadBlob(
    new Blob([JSON.stringify(data, null, 2)], { type: "application/json;charset=utf-8" }),
    `campus-week-planner-${getFileDate()}.json`,
  );
  addStatus("Timetable saved as a JSON file.");
}

function chooseTimetableFile() {
  elements.loadPlanInput.value = "";
  elements.loadPlanInput.click();
}

function loadTimetableFile(event) {
  const [file] = event.target.files;
  if (!file) return;

  const reader = new FileReader();

  reader.addEventListener("load", () => {
    try {
      const importedItems = normalizeTimetableImport(JSON.parse(String(reader.result || "")));

      if (state.items.length > 0) {
        const shouldSave = window.confirm("Save the current timetable before loading? Press OK to save it, or Cancel to discard it.");
        if (shouldSave) saveTimetableFile();
      }

      state.items = importedItems;
      resetForm();
      render();
      showFormMessage(`Loaded ${importedItems.length} item${importedItems.length === 1 ? "" : "s"}.`, "info");
      addStatus(`Loaded ${importedItems.length} timetable item${importedItems.length === 1 ? "" : "s"}.`);
    } catch {
      showFormMessage("Could not load this timetable file.", "danger");
      addStatus("The selected timetable file could not be loaded.", "danger");
    } finally {
      elements.loadPlanInput.value = "";
    }
  });

  reader.addEventListener("error", () => {
    showFormMessage("Could not read this timetable file.", "danger");
    addStatus("The selected timetable file could not be read.", "danger");
    elements.loadPlanInput.value = "";
  });

  reader.readAsText(file);
}

function normalizeTimetableImport(payload) {
  const source = Array.isArray(payload) ? payload : payload?.items;
  if (!Array.isArray(source)) throw new Error("Missing items.");

  const groupIds = new Map();
  return source.map((item, index) => normalizeImportedItem(item, index, groupIds));
}

function normalizeImportedItem(item, index, groupIds) {
  if (!item || typeof item !== "object") throw new Error(`Invalid item ${index + 1}.`);

  const title = String(item.title || "").trim();
  const type = String(item.type || "").trim();
  const day = String(item.day || "").trim();
  const start = Number(item.start);
  const end = Number(item.end);
  const originalGroupId = String(item.groupId || item.id || `imported-${index}`).trim();

  if (!title || title.length > 120) throw new Error(`Invalid title for item ${index + 1}.`);
  if (!ITEM_TYPES.has(type)) throw new Error(`Invalid type for item ${index + 1}.`);
  if (!DAYS.includes(day)) throw new Error(`Invalid day for item ${index + 1}.`);
  if (!Number.isInteger(start) || !Number.isInteger(end)) throw new Error(`Invalid time for item ${index + 1}.`);
  if (validateEntry({ title, days: [day], start, end })) throw new Error(`Invalid range for item ${index + 1}.`);

  if (!groupIds.has(originalGroupId)) {
    groupIds.set(originalGroupId, createId());
  }

  return {
    id: createId(),
    groupId: groupIds.get(originalGroupId),
    title,
    type,
    day,
    start,
    end,
    location: String(item.location || "").trim().slice(0, 36),
    color: HEX_COLOR_PATTERN.test(String(item.color || "")) ? item.color : DEFAULT_COLOR,
    autoGenerated: Boolean(item.autoGenerated),
  };
}

function getFileDate() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function exportPng() {
  const scale = 2;
  const timeWidth = 112;
  const dayWidth = 260;
  const titleHeight = 86;
  const headerHeight = 74;
  const hourHeight = 86;
  const padding = 26;
  const footerHeight = 30;
  const width = padding * 2 + timeWidth + dayWidth * DAYS.length;
  const height = padding * 2 + titleHeight + headerHeight + hourHeight * (END_HOUR - START_HOUR) + footerHeight;
  const canvas = document.createElement("canvas");
  canvas.width = width * scale;
  canvas.height = height * scale;
  const context = canvas.getContext("2d");

  context.scale(scale, scale);
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, width, height);
  drawTimetableImage(context, { padding, timeWidth, dayWidth, titleHeight, headerHeight, hourHeight, width, height });
  downloadCanvasPng(canvas, "campus-week-planner.png");
}

function drawTimetableImage(context, layout) {
  const { padding, timeWidth, dayWidth, titleHeight, headerHeight, hourHeight, width, height } = layout;
  const gridLeft = padding + timeWidth;
  const headerTop = padding + titleHeight;
  const gridTop = headerTop + headerHeight;
  const gridBottom = gridTop + hourHeight * (END_HOUR - START_HOUR);
  const conflicts = findConflicts(state.items);

  drawExportHeader(context, layout, conflicts);

  context.strokeStyle = "#d7d8d2";
  context.lineWidth = 1;
  context.strokeRect(padding, headerTop, width - padding * 2, gridBottom - headerTop);

  drawUscLogoCell(context, padding, headerTop, timeWidth, headerHeight);

  DAYS.forEach((day, index) => {
    const x = gridLeft + dayWidth * index;
    context.fillStyle = "#ffffff";
    context.fillRect(x, headerTop, dayWidth, headerHeight);
    context.fillStyle = "#394348";
    context.font = "900 18px Inter, Arial, sans-serif";
    context.textAlign = "center";
    context.fillText(day, x + dayWidth / 2, headerTop + 45);
    context.textAlign = "left";
  });

  for (let hour = START_HOUR; hour <= END_HOUR; hour += 1) {
    const y = gridTop + (hour - START_HOUR) * hourHeight;
    context.strokeStyle = "#d7d8d2";
    context.beginPath();
    context.moveTo(padding, y);
    context.lineTo(width - padding, y);
    context.stroke();

    if (hour < END_HOUR) {
      context.fillStyle = "#687177";
      context.font = "500 14px Inter, Arial, sans-serif";
      context.textAlign = "right";
      context.fillText(toClock(hour * MINUTES_PER_HOUR), padding + timeWidth - 14, y + 22);
      context.textAlign = "left";
    }
  }

  for (let index = 0; index <= DAYS.length; index += 1) {
    const x = gridLeft + dayWidth * index;
    context.strokeStyle = "#d7d8d2";
    context.beginPath();
    context.moveTo(x, headerTop);
    context.lineTo(x, gridBottom);
    context.stroke();
  }

  state.items
    .slice()
    .sort((a, b) => DAYS.indexOf(a.day) - DAYS.indexOf(b.day) || a.start - b.start)
    .forEach((item) => drawTimetableItem(context, item, conflicts.has(item.id), layout));

  context.fillStyle = "#687177";
  context.font = "500 13px Inter, Arial, sans-serif";
  context.fillText("Created with Campus Week Planner", padding, height - 12);
}

function drawUscLogoCell(context, x, y, width, height) {
  context.fillStyle = "#f8faf9";
  context.fillRect(x, y, width, height);
  context.fillStyle = "#990000";
  context.font = "900 34px Georgia, 'Times New Roman', serif";
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillText("USC", x + width / 2, y + height / 2 + 1, width - 18);
  context.textAlign = "left";
  context.textBaseline = "alphabetic";
}

function drawExportHeader(context, layout, conflicts) {
  const { padding, width, titleHeight } = layout;
  const itemCount = state.items.length;
  const studyCount = state.items.filter((item) => item.type === "Study").length;
  const summary = `${itemCount} item${itemCount === 1 ? "" : "s"} · ${studyCount} study · ${conflicts.size} conflict${conflicts.size === 1 ? "" : "s"}`;

  context.fillStyle = "#f7fbfa";
  context.fillRect(padding, padding, width - padding * 2, titleHeight - 12);
  context.fillStyle = "#e8f3f1";
  context.fillRect(padding, padding, 118, titleHeight - 12);

  drawRoundedRect(context, padding + 19, padding + 17, 78, 30, 15, "#ffffff");
  context.fillStyle = "#236369";
  context.font = "900 13px Inter, Arial, sans-serif";
  context.fillText("MON-FRI", padding + 30, padding + 37);

  context.fillStyle = "#202427";
  context.font = "900 28px Inter, Arial, sans-serif";
  context.fillText("Week Plan", padding + 142, padding + 35);
  context.fillStyle = "#536066";
  context.font = "600 14px Inter, Arial, sans-serif";
  context.fillText(summary, padding + 142, padding + 60);

  context.fillStyle = "#687177";
  context.font = "800 13px Inter, Arial, sans-serif";
  context.textAlign = "right";
  context.fillText("8 AM-10 PM", width - padding - 6, padding + 37);
  context.textAlign = "left";
}

function drawTimetableItem(context, item, hasConflict, layout) {
  const { padding, timeWidth, dayWidth, titleHeight, headerHeight, hourHeight } = layout;
  const dayIndex = DAYS.indexOf(item.day);
  if (dayIndex === -1) return;

  const x = padding + timeWidth + dayWidth * dayIndex + 10;
  const y = padding + titleHeight + headerHeight + ((item.start - START_HOUR * MINUTES_PER_HOUR) / MINUTES_PER_HOUR) * hourHeight + 5;
  const width = dayWidth - 20;
  const height = Math.max(54, ((item.end - item.start) / MINUTES_PER_HOUR) * hourHeight - 10);
  const color = item.type === "Study" ? STUDY_COLOR : item.color;
  const { code, name } = splitScheduleTitle(item.title);

  drawRoundedRect(context, x, y, width, height, 10, hasConflict ? "#a43f45" : color);
  context.fillStyle = hasConflict ? "#ffffff" : "#202427";
  context.font = "900 21px Inter, Arial, sans-serif";
  drawClippedText(context, code, x + 14, y + 28, width - 28);

  if (name && height > 72) {
    context.fillStyle = hasConflict ? "rgba(255,255,255,0.88)" : "rgba(32,36,39,0.72)";
    context.font = "700 13px Inter, Arial, sans-serif";
    wrapCanvasText(context, name, x + 14, y + 49, width - 28, 16, 2);
  }

  context.fillStyle = hasConflict ? "rgba(255,255,255,0.9)" : "rgba(32,36,39,0.78)";
  context.font = "600 13px Inter, Arial, sans-serif";
  const meta = `${item.type} · ${formatRange(item.start, item.end)}${item.location ? ` · ${item.location}` : ""}`;
  drawClippedText(context, meta, x + 14, y + height - 14, width - 28);
}

function drawRoundedRect(context, x, y, width, height, radius, color) {
  context.beginPath();
  context.moveTo(x + radius, y);
  context.lineTo(x + width - radius, y);
  context.quadraticCurveTo(x + width, y, x + width, y + radius);
  context.lineTo(x + width, y + height - radius);
  context.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
  context.lineTo(x + radius, y + height);
  context.quadraticCurveTo(x, y + height, x, y + height - radius);
  context.lineTo(x, y + radius);
  context.quadraticCurveTo(x, y, x + radius, y);
  context.closePath();
  context.fillStyle = color;
  context.fill();
}

function drawClippedText(context, text, x, y, maxWidth) {
  let output = text;
  while (context.measureText(output).width > maxWidth && output.length > 1) {
    output = `${output.slice(0, -2)}...`;
  }
  context.fillText(output, x, y);
}

function wrapCanvasText(context, text, x, y, maxWidth, lineHeight, maxLines) {
  const words = text.split(/\s+/);
  const lines = [];
  let line = "";

  words.forEach((word) => {
    const candidate = line ? `${line} ${word}` : word;
    if (context.measureText(candidate).width <= maxWidth) {
      line = candidate;
    } else {
      if (line) lines.push(line);
      line = word;
    }
  });
  if (line) lines.push(line);

  lines.slice(0, maxLines).forEach((currentLine, index) => {
    const isLastVisibleLine = index === maxLines - 1 && lines.length > maxLines;
    drawClippedText(context, isLastVisibleLine ? `${currentLine}...` : currentLine, x, y + index * lineHeight, maxWidth);
  });
}

function downloadCanvasPng(canvas, filename) {
  const link = document.createElement("a");
  link.href = canvas.toDataURL("image/png");
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function preparePrintLayout() {
  state.printMode = true;
  document.documentElement.style.setProperty("--hour-height", `${PRINT_HOUR_HEIGHT}px`);
  render();
}

function restoreScreenLayout() {
  state.printMode = false;
  document.documentElement.style.setProperty("--hour-height", `${SCREEN_HOUR_HEIGHT}px`);
  render();
}

elements.form.addEventListener("submit", handleSubmit);
elements.program.addEventListener("change", loadSelectedProgram);
elements.course.addEventListener("change", populateSectionSelect);
elements.section.addEventListener("change", previewSelectedUscSection);
elements.addSection.addEventListener("click", addSelectedUscSection);
elements.cancelEdit.addEventListener("click", resetForm);
elements.autoStudy.addEventListener("click", autoPlanStudyBlocks);
elements.clear.addEventListener("click", clearAll);
elements.sample.addEventListener("click", loadSampleSchedule);
elements.print.addEventListener("click", () => window.print());
elements.savePlan.addEventListener("click", saveTimetableFile);
elements.loadPlan.addEventListener("click", chooseTimetableFile);
elements.loadPlanInput.addEventListener("change", loadTimetableFile);
elements.exportPng.addEventListener("click", exportPng);
window.addEventListener("beforeprint", preparePrintLayout);
window.addEventListener("afterprint", restoreScreenLayout);

initializeCoursePicker();
refreshUscPrograms();
render();
