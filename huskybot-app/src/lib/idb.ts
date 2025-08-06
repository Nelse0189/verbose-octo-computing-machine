// src/lib/idb.ts

const DB_NAME = 'HuskyBotDB';
const DB_VERSION = 3;
const USER_COURSES_STORE_NAME = 'userCourses';
const COURSE_MATERIALS_STORE_NAME = 'courseMaterials';
const COURSE_ANNOUNCEMENTS_STORE_NAME = 'courseAnnouncements';


let db: IDBDatabase;

export const initDB = (): Promise<IDBDatabase> => {
  return new Promise((resolve, reject) => {
    if (db) {
      return resolve(db);
    }

    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onerror = (event) => {
      console.error('IndexedDB error:', request.error);
      reject('IndexedDB error');
    };

    request.onsuccess = (event) => {
      db = request.result;
      console.log('IndexedDB opened successfully');
      resolve(db);
    };

    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains(USER_COURSES_STORE_NAME)) {
        db.createObjectStore(USER_COURSES_STORE_NAME, { keyPath: 'netId' });
        console.log('Object store created:', USER_COURSES_STORE_NAME);
      }
      if (!db.objectStoreNames.contains(COURSE_MATERIALS_STORE_NAME)) {
        db.createObjectStore(COURSE_MATERIALS_STORE_NAME, { keyPath: 'courseName' });
        console.log('Object store created:', COURSE_MATERIALS_STORE_NAME);
      }
      if (!db.objectStoreNames.contains(COURSE_ANNOUNCEMENTS_STORE_NAME)) {
        db.createObjectStore(COURSE_ANNOUNCEMENTS_STORE_NAME, { keyPath: 'courseName' });
        console.log('Object store created:', COURSE_ANNOUNCEMENTS_STORE_NAME);
      }
    };
  });
};

export const saveCourses = async (netId: string, courses: string[]): Promise<void> => {
  const db = await initDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(USER_COURSES_STORE_NAME, 'readwrite');
    const store = transaction.objectStore(USER_COURSES_STORE_NAME);
    const data = {
      netId,
      courses,
      updatedAt: new Date(),
    };

    const request = store.put(data);

    request.onsuccess = () => {
      console.log(`Courses for ${netId} saved to IndexedDB.`);
      resolve();
    };

    request.onerror = () => {
      console.error('Error saving courses:', request.error);
      reject(request.error);
    };
  });
};

export const getCourses = async (netId: string): Promise<{ netId: string; courses: string[]; updatedAt: Date } | undefined> => {
  const db = await initDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(USER_COURSES_STORE_NAME, 'readonly');
    const store = transaction.objectStore(USER_COURSES_STORE_NAME);
    const request = store.get(netId);

    request.onsuccess = () => {
      resolve(request.result);
    };

    request.onerror = () => {
      console.error('Error fetching courses:', request.error);
      reject(request.error);
    };
  });
};

export interface CourseMaterial {
  title: string;
  content: string; // text content
  images: {
      alt: string;
      src: string;
  }[];
  files?: {
      fileName: string;
      data: string; // base64 encoded
  }[];
  // maybe other things later like files
}

export interface CourseData {
  courseName: string;
  materials: CourseMaterial[];
  updatedAt: Date;
}

export const saveCourseMaterial = async (courseName: string, material: CourseMaterial): Promise<void> => {
  const db = await initDB();
  return new Promise((resolve, reject) => {
      const transaction = db.transaction(COURSE_MATERIALS_STORE_NAME, 'readwrite');
      const store = transaction.objectStore(COURSE_MATERIALS_STORE_NAME);

      const getRequest = store.get(courseName);

      getRequest.onsuccess = () => {
          const existingData: CourseData | undefined = getRequest.result;
          const materials = existingData ? [...existingData.materials] : [];
          
          // Avoid duplicates
          const existingMaterialIndex = materials.findIndex(m => m.title === material.title);
          if (existingMaterialIndex > -1) {
              materials[existingMaterialIndex] = material;
          } else {
              materials.push(material);
          }

          const dataToSave: CourseData = {
              courseName,
              materials,
              updatedAt: new Date()
          };
          
          const putRequest = store.put(dataToSave);

          putRequest.onsuccess = () => {
              console.log(`Material "${material.title}" for course ${courseName} saved to IndexedDB.`);
              resolve();
          };

          putRequest.onerror = () => {
              console.error('Error saving course material:', putRequest.error);
              reject(putRequest.error);
          };
      };
      
      getRequest.onerror = () => {
          console.error('Error fetching existing course data:', getRequest.error);
          reject(getRequest.error);
      };
  });
};

export const getCourseMaterials = async (courseName: string): Promise<CourseData | undefined> => {
  const db = await initDB();
  return new Promise((resolve, reject) => {
      const transaction = db.transaction(COURSE_MATERIALS_STORE_NAME, 'readonly');
      const store = transaction.objectStore(COURSE_MATERIALS_STORE_NAME);
      const request = store.get(courseName);

      request.onsuccess = () => {
          resolve(request.result);
      };

      request.onerror = () => {
          console.error('Error fetching course materials:', request.error);
          reject(request.error);
      };
  });
};

export interface Announcement {
    title: string;
    content: string;
}

export interface CourseAnnouncementsData {
    courseName: string;
    announcements: Announcement[];
    updatedAt: Date;
}

export const saveAnnouncements = async (courseName:string, announcements: Announcement[]): Promise<void> => {
    const db = await initDB();
    return new Promise((resolve, reject) => {
        const transaction = db.transaction(COURSE_ANNOUNCEMENTS_STORE_NAME, 'readwrite');
        const store = transaction.objectStore(COURSE_ANNOUNCEMENTS_STORE_NAME);
        const data: CourseAnnouncementsData = {
            courseName,
            announcements,
            updatedAt: new Date(),
        };
        const request = store.put(data);

        request.onsuccess = () => {
            console.log(`${announcements.length} announcements for course ${courseName} saved to IndexedDB.`);
            resolve();
        };

        request.onerror = () => {
            console.error(`Error saving announcements for ${courseName}:`, request.error);
            reject(request.error);
        };
    });
};

export const getAnnouncements = async (courseName: string): Promise<CourseAnnouncementsData | undefined> => {
    const db = await initDB();
    return new Promise((resolve, reject) => {
        const transaction = db.transaction(COURSE_ANNOUNCEMENTS_STORE_NAME, 'readonly');
        const store = transaction.objectStore(COURSE_ANNOUNCEMENTS_STORE_NAME);
        const request = store.get(courseName);

        request.onsuccess = () => {
            resolve(request.result);
        };

        request.onerror = () => {
            console.error('Error fetching announcements:', request.error);
      reject(request.error);
    };
  });
}; 