import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

export const TERM_CODE = 20263;
const BASE_URL = "https://classes.usc.edu";
const DATA_DIR = new URL("../usc-data/20263/", import.meta.url);
const PROGRAMS_FILE = new URL("../usc-programs.js", import.meta.url);

export async function fetchJson(path) {
  const response = await fetch(`${BASE_URL}${path}`);
  if (!response.ok) {
    throw new Error(`USC request failed ${response.status}: ${path}`);
  }
  return response.json();
}

export function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function courseCode(course) {
  return (
    course.matchedCourseCode?.courseSpace ||
    course.publishedCourseCode?.courseSpace ||
    course.scheduledCourseCode?.courseSpace ||
    course.fullCourseName ||
    `${course.prefix || ""} ${course.classNumber || ""}`.trim()
  );
}

function instructorNames(section) {
  return (section.instructors || [])
    .map((instructor) => cleanText(instructor.personName || `${instructor.firstName || ""} ${instructor.lastName || ""}`))
    .filter(Boolean);
}

function normalizeSection(section) {
  return {
    id: String(section.sisSectionId || section.peSectionId || ""),
    mode: cleanText(section.rnrMode || section.classType || "Class"),
    units: (section.units || []).map(cleanText).filter(Boolean),
    instructors: instructorNames(section),
    schedule: (section.schedule || [])
      .map((meeting) => ({
        days: (meeting.days || []).map(cleanText).filter(Boolean),
        startTime: cleanText(meeting.startTime),
        endTime: cleanText(meeting.endTime),
      }))
      .filter((meeting) => meeting.days.length > 0 && meeting.startTime && meeting.endTime),
    totalSeats: section.totalSeats ?? null,
    registeredSeats: section.registeredSeats ?? null,
    hasDClearance: Boolean(section.hasDClearance),
    isCancelled: Boolean(section.isCancelled),
    isFull: Boolean(section.isFull),
    notes: cleanText(section.notes || section.description),
  };
}

export function normalizeCourse(course) {
  const code = cleanText(courseCode(course));
  const name = cleanText(course.name);
  return {
    id: course.courseId,
    code,
    name,
    title: name ? `${code} - ${name}` : code,
    units: (course.courseUnits || []).map(String),
    sections: (course.sections || []).map(normalizeSection).filter((section) => section.id && section.schedule.length > 0),
  };
}

export async function getPrograms() {
  const schools = await fetchJson(`/api/Schools/TermCode?termCode=${TERM_CODE}`);
  return schools
    .flatMap((school) =>
      (school.programs || []).map((program) => ({
        key: `${school.prefix}-${program.prefix}`,
        schoolPrefix: school.prefix,
        schoolName: cleanText(school.name),
        programPrefix: program.prefix,
        programName: cleanText(program.name),
        url: `${BASE_URL}/term/${TERM_CODE}/catalogue/program/${program.prefix}/school/${school.prefix}`,
        file: `usc-data/${TERM_CODE}/${school.prefix}-${program.prefix}.json`,
      })),
    )
    .sort((a, b) => a.programName.localeCompare(b.programName) || a.schoolName.localeCompare(b.schoolName));
}

export async function getProgramData(program) {
  const source = await fetchJson(
    `/api/Courses/CoursesByTermSchoolProgram?termCode=${TERM_CODE}&school=${encodeURIComponent(program.schoolPrefix)}&program=${encodeURIComponent(program.programPrefix)}`,
  );

  return {
    termCode: TERM_CODE,
    generatedAt: new Date().toISOString(),
    key: program.key,
    schoolPrefix: program.schoolPrefix,
    schoolName: program.schoolName,
    programPrefix: program.programPrefix,
    programName: program.programName,
    sourceUrl: program.url,
    courses: (source.courses || []).map(normalizeCourse).filter((course) => course.sections.length > 0),
  };
}

export async function writeProgramsFile(programs) {
  await writeFile(
    PROGRAMS_FILE,
    `// Generated from USC Schedule of Classes term ${TERM_CODE}.\nwindow.USC_PROGRAMS = ${JSON.stringify(programs, null, 2)};\n`,
  );
}

export async function writeProgramData(program, payload) {
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(new URL(`${program.key}.json`, DATA_DIR), `${JSON.stringify(payload)}\n`);
}

export async function generateUscData() {
  await mkdir(DATA_DIR, { recursive: true });

  const programs = await getPrograms();

  let completed = 0;
  for (const program of programs) {
    const payload = await getProgramData(program);
    await writeProgramData(program, payload);
    completed += 1;
    if (completed % 25 === 0) {
      console.log(`Generated ${completed}/${programs.length} programs`);
    }
  }

  await writeProgramsFile(programs);
  console.log(`Generated ${programs.length} programs.`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  generateUscData().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
